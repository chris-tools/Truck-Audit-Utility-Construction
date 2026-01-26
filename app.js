(function(){
  const $ = (id)=>document.getElementById(id);

  const modeAuditBtn = $('modeAuditBtn');
  const modeQuickBtn = $('modeQuickBtn');
  const auditSection = $('auditSection');
  const scanSection = $('scanSection');
  const excelFile = $('excelFile');
  const fileMeta = $('fileMeta');
  const colPicker = $('colPicker');
  const serialCol = $('serialCol');
  const partCol = $('partCol');
  const expectedSummary = $('expectedSummary');

  const startScan = $('startScan');
  const stopScan = $('stopScan');
  const flashBtn = $('flashBtn');
  const video = $('video');
  const banner = $('banner');

  const statExpected = $('statExpected');
  const statMatched = $('statMatched');
  const statMissing = $('statMissing');
  const statExtra = $('statExtra');
  const statDup = $('statDup');

  const manualSerial = $('manualSerial');
  const addManual = $('addManual');

  const copyNextMissing = $('copyNextMissing');
  const copyAllMissing = $('copyAllMissing');
  const copyAllScanned = $('copyAllScanned');

  const missingList = $('missingList');
  const extraList = $('extraList');
  const scannedList = $('scannedList');

  let mode = null; // 'audit' | 'quick'
  let expected = new Map(); // serial -> {part}
  let scanned = new Set();  // unique
  let extras = new Set();
  let dupCount = 0;
  let matchedCount = 0;

  let handledMissing = new Set();
  let missingQueue = [];

  let scanner = null;
  let streamTrack = null;
  let cameraStream = null;
  let torchSupported = false;
  let torchOn = false;
  let zoomSupported = false;
  let preferredDeviceId = null;
  let armed = false;           // one scan per click
  let startingCamera = false;  // prevents double-start
  let hasScannedOnce = false;
  let armTimeoutId = null;
  let audioCtx = null;

  function ensureAudio(){
    if(audioCtx) return audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return null;
    audioCtx = new Ctx();
    return audioCtx;
  }

  function beep(freq=880, durationMs=90, gainValue=0.7){
    const ctx = ensureAudio();
    if(!ctx) return;
    // Some iOS versions start suspended until a user gesture; Scan click counts.
    if(ctx.state === 'suspended') { ctx.resume().catch(()=>{}); }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = 0;

    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    const dur = Math.max(0.02, durationMs/1000);

    // Fast attack, short sustain, quick release.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainValue), now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  function scanStartSound(){
    beep(880, 60, 0.35);
  }

  function scanSuccessSound(){
  beep(2000, 180, 1.0);     // sharp confirmation
  setTimeout(() => beep(1200, 140, 1.0), 190); // softer tail
}

  function setBanner(kind, text){
    banner.hidden = false;
    banner.className = 'banner ' + kind;
    banner.textContent = text;
    if(kind === 'ok'){
      setTimeout(()=>{ banner.hidden = true; }, 900);
    }
  }

  function normalizeSerial(s){
  if(!s) return '';
  return String(s).trim().toUpperCase();
}

function stripControlChars(s){
  // Remove non-printable characters that sometimes appear in 2D barcode payloads
  return String(s || '').replace(/[\u0000-\u001F\u007F]/g, '');
}

function looksLikeSerial(s){
  if(!s) return false;

  // Allow longer 2D payloads
  if(s.length < 7 || s.length > 40) return false;

  // Allow common serial characters only
  if(!/^[A-Z0-9\-\/]+$/.test(s)) return false;

  // Prefer mixed serials (letters + numbers)
  const hasLetter = /[A-Z]/.test(s);
  const hasNumber = /[0-9]/.test(s);

  if(hasLetter && hasNumber) return true;

  // If numeric-only, require it to be long enough
  if(/^[0-9]+$/.test(s)) return s.length >= 12;

  return false;
}

  function resetSession(){
    expected.clear();
    scanned = new Set();
    extras = new Set();
    handledMissing = new Set();
    dupCount = 0;
    matchedCount = 0;
    missingQueue = [];
    hasScannedOnce = false;
    updateUI();
  }

  function updateCounts(){
    statExpected.textContent = mode === 'audit' ? String(expected.size) : '—';
    statMatched.textContent = mode === 'audit' ? String(matchedCount) : '—';
    statExtra.textContent = String(extras.size);
    statDup.textContent = String(dupCount);
    if(mode === 'audit'){
      statMissing.textContent = String(Math.max(0, expected.size - matchedCount - handledMissing.size));
    } else {
      statMissing.textContent = '—';
    }
  }

  function renderList(container, items, partLookup){
    container.innerHTML = '';
    if(items.length === 0){
      container.innerHTML = '<div class="meta">None</div>';
      return;
    }
    for(const s of items){
      const div = document.createElement('div');
      div.className = 'item';
      div.textContent = s;
      if(partLookup){
        const p = partLookup.get(s);
        if(p){
          const b = document.createElement('span');
          b.className = 'badge';
          b.textContent = p;
          div.appendChild(b);
        }
      }
      container.appendChild(div);
    }
  }

  function regenerateMissingQueue(){
    if(mode !== 'audit') { missingQueue = []; return; }
    const missing = [];
    for(const s of expected.keys()){
      if(!scanned.has(s) && !handledMissing.has(s)) missing.push(s);
    }
    missing.sort((a,b)=>{
      const pa = expected.get(a)?.part || '';
      const pb = expected.get(b)?.part || '';
      if(pa < pb) return -1;
      if(pa > pb) return 1;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    missingQueue = missing;
  }

  function updateUI(){
    updateCounts();

    copyAllScanned.disabled = scanned.size === 0;

    if(mode === 'audit'){
      regenerateMissingQueue();
      copyNextMissing.disabled = missingQueue.length === 0;
      copyAllMissing.disabled = missingQueue.length === 0;
    } else {
      copyNextMissing.disabled = true;
      copyAllMissing.disabled = true;
    }

    const scannedArr = Array.from(scanned).sort();
    const extraArr = Array.from(extras).sort();

    const partLookup = (mode==='audit')
      ? new Map(Array.from(expected.entries()).map(([k,v])=>[k, v.part]))
      : null;

    renderList(scannedList, scannedArr, partLookup);
    renderList(extraList, extraArr, null);

    if(mode === 'audit'){
      renderList(missingList, missingQueue, partLookup);
    } else {
      missingList.innerHTML = '<div class="meta">Upload Excel and scan to see missing.</div>';
    }
  }

  function copyText(txt){
 
  // 1) Sync copy FIRST (best compatibility during a button click)
  try{
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.setAttribute('readonly','');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);

    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);

    const ok = document.execCommand('copy');
    document.body.removeChild(ta);

    if(ok){
      setBanner('ok','Copied');
      return;
    }
  }catch(e){
    // keep going
  }

  // 2) Async clipboard SECOND
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt)
      .then(()=> setBanner('ok','Copied'))
      .catch(()=> window.prompt('Copy this:', txt));
  }else{
    window.prompt('Copy this:', txt);
  }
}
  // Export button
  function updateExportButtonState() {
  const btn = document.getElementById('exportCsv');
  if (!btn) return;

  // Enable export if there is anything meaningful to export.
  // In this app:
  // - scanned = Set of found serials
  // - extras  = Set of extra serials
  // - in audit mode, expected.size > 0 means there is a loaded inventory list (missing can be derived)
  const hasData =
    (scanned && scanned.size > 0) ||
    (extras && extras.size > 0) ||
    (mode === 'audit' && expected && expected.size > 0);

  btn.disabled = !hasData;
}

  function onSerialScanned(raw){
    const s = normalizeSerial(raw);
    if(!s) return;

    if(scanned.has(s)){
      dupCount += 1;
      setBanner('warn', 'Serial Already Scanned: ' + s);
      updateUI();
      return;
    }

    scanned.add(s);

    if(mode === 'audit' && expected.size > 0){
      if(expected.has(s)){
        matchedCount += 1;
        const p = expected.get(s)?.part;
        setBanner('ok', p ? ('Expected: ' + s + ' • ' + p) : ('Expected: ' + s));
      } else {
        extras.add(s);
        setBanner('warn', 'Extra (not on list): ' + s);
      }
    } else {
      setBanner('ok', 'Added: ' + s);
    }

    updateUI();

    updateExportButtonState();

  }

  function fillSelect(selectEl, headers){
    selectEl.innerHTML = '';
    for(const h of headers){
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      selectEl.appendChild(opt);
    }
  }

  function guessColumn(headers, candidates){
    const lower = headers.map(h=>h.toLowerCase());
    for(const c of candidates){
      const idx = lower.indexOf(c.toLowerCase());
      if(idx >= 0) return headers[idx];
    }
    for(const c of candidates){
      const idx = lower.findIndex(h=>h.includes(c.toLowerCase()));
      if(idx >= 0) return headers[idx];
    }
    return headers[0] || '';
  }

  async function parseExcel(file){
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:true});
    if(rows.length < 2) throw new Error('Sheet seems empty');

    const headers = rows[0].map(h=>String(h||'').trim()).filter(Boolean);
    const dataRows = rows.slice(1).filter(r=>r && r.length>0);
    return {sheetName, headers, dataRows};
  }

  function loadExpectedFromRows(headers, dataRows, serialHeader, partHeader){
    expected.clear();
    const hIndex = new Map();
    headers.forEach((h,i)=>hIndex.set(h,i));

    const si = hIndex.get(serialHeader);
    const pi = partHeader ? hIndex.get(partHeader) : undefined;
    const qi = hIndex.get('Quality');
    const li = hIndex.get('Last Date');


    for(const r of dataRows){
      const s = normalizeSerial(r[si]);
      if(!s) continue;
      const p = (pi !== undefined) ? String(r[pi] ?? '').trim() : '';
      const q = (qi !== undefined) ? String(r[qi] ?? '').trim() : '';
      const ld = (li !== undefined) ? String(r[li] ?? '').trim() : '';
      expected.set(s, { part: p, quality: q, lastDate: ld });
    }

    matchedCount = 0;
    extras = new Set(extras); // keep any extras if already scanned
    for(const s of scanned){
      if(expected.has(s)) matchedCount += 1;
      else extras.add(s);
    }
    handledMissing = new Set(); // reset handled when inventory reloads
  }

  modeAuditBtn.addEventListener('click', ()=>{
    mode = 'audit';
    resetSession();
    auditSection.hidden = false;
    scanSection.hidden = false;
    expectedSummary.textContent = 'Upload the Excel you were emailed. Then scan everything on the truck.';
    setBanner('ok', 'Audit mode ready');
    updateUI();
  });

  modeQuickBtn.addEventListener('click', ()=>{
    mode = 'quick';
    resetSession();
    auditSection.hidden = true;
    scanSection.hidden = false;
    setBanner('ok', 'Quick Scan mode ready');
    updateUI();
  });

  excelFile.addEventListener('change', async ()=>{
  const f = excelFile.files && excelFile.files[0];
  if(!f) return;

  fileMeta.textContent = f.name;

  try{
    const {sheetName, headers, dataRows} = await parseExcel(f);

    // Locked column names (no user selection)
    const serialHeader = headers.includes('Serial No')
      ? 'Serial No'
      : guessColumn(headers, ['Serial No','Serial','Serial Number','SN']);

    const partHeader = headers.includes('Part')
      ? 'Part'
      : guessColumn(headers, ['Part','Item','Description']);

    if(!serialHeader){
      throw new Error('Could not find a Serial column in the Excel sheet.');
    }

    const partHeaderFinal = headers.includes(partHeader) ? partHeader : '';

    loadExpectedFromRows(headers, dataRows, serialHeader, partHeaderFinal);

    expectedSummary.textContent =
      `Loaded sheet “${sheetName}”. Expected serials: ${expected.size}.`;

    updateUI();
  } catch(e){
    expectedSummary.textContent = 'Could not read Excel: ' + e.message;
  }
});

  async function startCamera(){
    const devices = await ZXingBrowser.BrowserMultiFormatReader.listVideoInputDevices();

    // Prefer the rear camera. On iOS, device labels may be empty until permission is granted;
    // in that case, the "environment" camera is often the *last* entry.
    let deviceId = preferredDeviceId;
    if(!deviceId){
      const byLabel = (devices || []).find(d=>/back|rear|environment/i.test(d.label||''));
      if(byLabel) deviceId = byLabel.deviceId;
      else if(devices && devices.length) deviceId = devices[devices.length - 1].deviceId;
    }
    preferredDeviceId = deviceId || null;

   scanner = new ZXingBrowser.BrowserMultiFormatReader();
  
    // Ask for a sharper video feed (helps tiny 2D codes a LOT)
const constraints = {
  audio: false,
  video: {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    facingMode: deviceId ? undefined : { ideal: 'environment' },

    // High-res request (reliability > battery)
    width:  { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 }
  }
};

await scanner.decodeFromConstraints(constraints, video, (result, err)=>{

  // Only act on a real decode result, and only when the user has armed scanning
if(!result || !armed) return;

const rawText = result.getText();
const cleaned = normalizeSerial(stripControlChars(rawText));

// If the decode looks like junk, ignore it and KEEP scanning (do not disarm)
if(!looksLikeSerial(cleaned)){
  setBanner('warn', 'Unclear scan — hold steadier and try again');
  return;
}

// One-scan-per-click: accept first VALID result, then disarm until the user taps Scan Next.
armed = false;
hasScannedOnce = true;
if(armTimeoutId){ clearTimeout(armTimeoutId); armTimeoutId = null; }

scanSuccessSound();
onSerialScanned(cleaned);

  // Shut the camera off after a successful scan
  stopCamera().then(()=>{
    startScan.disabled = false;
    startScan.textContent = 'Scan Next';
    stopScan.disabled = true;
    setBanner('ok', 'Scan saved — camera off');
  });
});

    try{
      const stream = video.srcObject;
      cameraStream = stream;
      if(stream){
        streamTrack = stream.getVideoTracks()[0];
        const caps = streamTrack.getCapabilities ? streamTrack.getCapabilities() : {};
        torchSupported = !!caps.torch;
        flashBtn.hidden = false;
        flashBtn.disabled = !torchSupported;
        torchOn = false;
        flashBtn.textContent = torchSupported ? 'Flashlight' : 'Flashlight (N/A)';
        flashBtn.classList.remove('on');

        // Default zoom: if the device supports it, gently zoom in to help barcode reading.
        zoomSupported = typeof caps.zoom === 'object' && caps.zoom !== null;
        if(zoomSupported){
          const minZ = Number(caps.zoom.min ?? 1);
          const maxZ = Number(caps.zoom.max ?? 1);
          const target = Math.min(maxZ, Math.max(minZ, 2)); // aim for ~2x without exceeding caps
          try{
            await streamTrack.applyConstraints({advanced:[{zoom: target}]});
          }catch(_){/* ignore */}
        }
      }
    }catch(_){}
  }

async function stopCamera(){
  try{
    const stream = cameraStream || video?.srcObject;

    // Best-effort: turn torch off before stopping tracks (prevents some iOS weirdness)
    if(streamTrack && torchSupported && torchOn){
      try{ await streamTrack.applyConstraints({advanced:[{torch:false}]}); }catch(_){}
    }

    // Stop ALL tracks (not just one stored track)
    if(stream && typeof stream.getTracks === 'function'){
      stream.getTracks().forEach(t => t.stop());
    }else if(streamTrack){
      streamTrack.stop(); // fallback
    }
    // Now stop the ZXing decoder
if(scanner) scanner.reset();
    
if(video){
  try{ video.pause(); }catch(_){}
  video.srcObject = null;
  try{ video.removeAttribute('src'); }catch(_){}
  try{ video.load(); }catch(_){}
}

// Clear stored stream reference
cameraStream = null;


  }catch(_){}

  // Reset state
  scanner = null;
  streamTrack = null;
  torchSupported = false;
  torchOn = false;
  zoomSupported = false;

  flashBtn.hidden = false;
  flashBtn.disabled = true;
  flashBtn.textContent = 'Flashlight';
  flashBtn.classList.remove('on');
}
startScan.addEventListener('click', async ()=>{
    const originalLabel = startScan.textContent;
    startScan.disabled = true;
    startScan.textContent = 'Scanning…';
    stopScan.disabled = false;
    scanStartSound();

    try{
      // Start the camera once, then perform one scan per tap.
      if(!streamTrack && !startingCamera){
        startingCamera = true;
        await startCamera();
        startingCamera = false;
        setBanner('ok', 'Camera started');
      }

      // Arm for exactly one scan. The decode callback will disarm + re-enable the button.
      armed = true;
      if(armTimeoutId){ clearTimeout(armTimeoutId); }
      armTimeoutId = setTimeout(()=>{
        if(!armed) return;
        armed = false;
        stopCamera().then(()=>{
        startScan.disabled = false;
        startScan.textContent = hasScannedOnce ? 'Scan Next' : 'Scan';
        stopScan.disabled = true;
        setBanner('warn', 'Timed out — tap Scan Next to try again');
          });
      }, 30000);
    }catch(e){
      startingCamera = false;
      armed = false;
      setBanner('bad', 'Camera error: ' + e.message);
      startScan.disabled = false;
      startScan.textContent = originalLabel === 'Scan Next' ? 'Scan' : originalLabel;
      stopScan.disabled = true;
    }
  });

  stopScan.addEventListener('click', async ()=>{
    // Turn flashlight off immediately when finishing.
    if(streamTrack && torchSupported && torchOn){
      try{ await streamTrack.applyConstraints({advanced:[{torch: false}]}); }catch(_){/* ignore */}
    }
    torchOn = false;
    flashBtn.textContent = torchSupported ? 'Flashlight' : 'Flashlight (N/A)';
    flashBtn.classList.remove('on');
    armed = false;
    hasScannedOnce = false;
    if(armTimeoutId){ clearTimeout(armTimeoutId); armTimeoutId = null; }

    await stopCamera();
    startScan.disabled = false;
    startScan.textContent = 'Scan';
    stopScan.disabled = true;
    setBanner('ok', 'Finished');
  });

  flashBtn.addEventListener('click', async ()=>{
    if(!streamTrack) return;
    if(!torchSupported){
      setBanner('warn', 'Flashlight not available on this device');
      return;
    }
    torchOn = !torchOn;
    try{
      await streamTrack.applyConstraints({advanced:[{torch: torchOn}]});
      flashBtn.textContent = torchOn ? 'Flashlight On' : 'Flashlight';
      flashBtn.classList.toggle('on', torchOn);
    }catch(e){
      setBanner('warn', 'Flashlight not available');
    }
  });

  addManual.addEventListener('click', ()=>{
    const s = normalizeSerial(manualSerial.value);
    if(!s) return;
    onSerialScanned(s);
    manualSerial.value = '';
  });

  manualSerial.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      e.preventDefault();
      addManual.click();
    }
  });

  copyAllScanned.addEventListener('click', (e)=>{
  e.preventDefault();
  e.stopPropagation();
 
  const arr = Array.from(scanned).sort();
  copyText(arr.join('\n'));
});

  copyAllMissing.addEventListener('click', ()=>{
    if(mode !== 'audit') return;
    regenerateMissingQueue();
    copyText(missingQueue.join('\n'));
  });

  copyNextMissing.addEventListener('click', ()=>{
    if(mode !== 'audit') return;
    regenerateMissingQueue();
    if(missingQueue.length === 0) return;
    const next = missingQueue[0];
    handledMissing.add(next);
    copyText(next);
    updateUI();
  });
  const exportBtn = document.getElementById('exportCsv');

if (exportBtn) {
  exportBtn.addEventListener('click', () => {
    if (exportBtn.disabled) return;

    const techName = window.prompt('Tech name (required):', '');
    if (!techName || !techName.trim()) return;

    const d = new Date();  // MM/DD/YYYY
const auditDate =
  String(d.getMonth() + 1).padStart(2, '0') + '/' +
  String(d.getDate()).padStart(2, '0') + '/' +
  d.getFullYear();

  // Build rows: Tech Name, Audit Date, Status, Serial, Part
const rows = [];
rows.push(['Tech Name','Audit Date','Serial','Part','Quality','Last Date','Status']);

const tech = techName.trim();

// Part lookup (only available when Excel is loaded in audit mode)
const partFor = (serial) => {
  if (mode === 'audit' && expected && expected.size > 0 && expected.has(serial)) {
    return expected.get(serial)?.part || '';
  }
  return '';
};
const qualityFor = (serial) => {
  if (mode === 'audit' && expected && expected.size > 0 && expected.has(serial)) {
    return expected.get(serial)?.quality || '';
  }
  return '';
};

const lastDateFor = (serial) => {
  if (mode === 'audit' && expected && expected.size > 0 && expected.has(serial)) {
    return expected.get(serial)?.lastDate || '';
  }
  return '';
};

// Found
const foundSerials = (mode === 'audit' && expected && expected.size > 0)
  ? Array.from(scanned).filter(s => expected.has(s)).sort()
  : Array.from(scanned).sort();

for (const s of foundSerials) {
  rows.push([tech, auditDate, s, partFor(s), qualityFor(s), lastDateFor(s), 'Found']);
}

// Missing (only meaningful in audit mode)
if (mode === 'audit') {
  regenerateMissingQueue(); // ensure it's up to date
  for (const s of (missingQueue || [])) {
    rows.push([tech, auditDate, s, partFor(s), qualityFor(s), lastDateFor(s), 'Missing']);
  }
}

// Extra (only meaningful in audit mode; in quick mode extras is typically empty)
for (const s of Array.from(extras || []).sort()) {
  rows.push([tech, auditDate, s, '', '', '', 'Extra']);
}

// CSV encode
const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csv = rows.map(r => r.map(esc).join(',')).join('\n');

// Download
const safeDate = new Date().toISOString().slice(0,10); // YYYY-MM-DD for filename
const safeTech = tech.replace(/[^A-Za-z0-9_-]+/g, '_');
const filename = `TAU_Audit_${safeDate}_${safeTech}.csv`;

const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
const url = URL.createObjectURL(blob);

const a = document.createElement('a');
a.href = url;
a.download = filename;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);

setTimeout(() => URL.revokeObjectURL(url), 1000);

  });
}


  // PWA install hint
  let deferredPrompt = null;
  const installBtn = $('installBtn');
  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', async ()=>{
    if(!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt = null;
    installBtn.hidden = true;
  });
// Safety net: if the user navigates away / backgrounds the app, release the camera
window.addEventListener('pagehide', ()=>{ stopCamera(); });
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden) stopCamera();
});

// ===== Construction site: prevent service worker caching (SAFE) =====
if ('serviceWorker' in navigator) {
  const isConstruction =
    location.hostname === 'chris-tools.github.io' &&
    location.pathname.startsWith('/Truck-Audit-Utility-Construction/');

  if (isConstruction) {
    // Only remove SW registrations that belong to the Construction site
    window.addEventListener('load', async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const reg of regs) {
          const scope = reg.scope || '';
          const scriptURL =
            (reg.active && reg.active.scriptURL) ||
            (reg.waiting && reg.waiting.scriptURL) ||
            (reg.installing && reg.installing.scriptURL) ||
            '';

          const belongsToConstruction =
            scope.includes('/Truck-Audit-Utility-Construction/') ||
            scriptURL.includes('/Truck-Audit-Utility-Construction/');

          if (belongsToConstruction) {
            await reg.unregister();
          }
        }
      } catch (e) {}
    });

  } else {
    // Production: keep SW enabled
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}

  setBanner('ok', 'Choose a mode to begin');
  updateUI();

/* Reload warning dismiss */
const reloadWarning = document.getElementById('reloadWarning');
const dismissWarningBtn = document.querySelector('.dismissWarning');

if(dismissWarningBtn && reloadWarning){
  dismissWarningBtn.addEventListener('click', () => {
    reloadWarning.style.display = 'none';
  });
}
  const manualInput = document.getElementById('manualSerial');
  const addManualBtn = document.getElementById('addManual');

 if (manualInput && addManualBtn) {
    manualInput.addEventListener('input', () => {
    addManualBtn.disabled = manualInput.value.trim() === '';
  });
}

updateExportButtonState();
})();
