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
  const techNameField = $('techNameField');
  const contractorField = $('contractorField');

  const startScan = $('startScan');
  const stopScan = $('stopScan');
  const flashBtn = $('flashBtn');
  const video = $('video');
  const banner = $('banner');
  const IDLE_BANNER_TEXT = 'Scan status: Ready';
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
  const foundCount = $('foundCount');
  const missingCount = $('missingCount');
  const extraCount = $('extraCount');


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
  let armDelayId = null;
  let lastCandidate = '';
  let candidateSince = 0;
  const DWELL_MS = 250; // milliseconds a code must stay steady

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
  
function setIdleBanner(){
  if(!banner) return;
  banner.hidden = false;
  banner.className = 'banner idle';
  banner.textContent = 'Scan status: Ready';
}

 function setBanner(kind, text){
  if(!banner) return;

  banner.hidden = false;
  banner.className = 'banner ' + kind;
  banner.textContent = text;

  if(kind === 'ok'){
    setTimeout(()=>{
      setIdleBanner(); // go back to the idle message
    }, 900);
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
  function getResultCenter(result){
  try{
    const pts =
      (typeof result.getResultPoints === 'function' && result.getResultPoints()) ||
      result.resultPoints ||
      [];

    if(!pts || pts.length === 0) return null;

    let sx = 0, sy = 0, n = 0;
    for(const p of pts){
      const x = (typeof p.getX === 'function') ? p.getX() : p.x;
      const y = (typeof p.getY === 'function') ? p.getY() : p.y;
      if(typeof x === 'number' && typeof y === 'number'){
        sx += x;
        sy += y;
        n += 1;
      }
    }

    if(n === 0) return null;
    return { x: sx / n, y: sy / n };
  }catch(_){
    return null;
  }
}

function isCenteredDecode(result, videoEl, tolerance = 0.22){
  // tolerance = fraction of frame from center (0.22 ≈ 22%)
  const c = getResultCenter(result);
  if(!c) return true; // no points → don’t block scan

  const w = videoEl?.videoWidth || 0;
  const h = videoEl?.videoHeight || 0;
  if(!w || !h) return true;

  const cx = w / 2;
  const cy = h / 2;

  const dx = Math.abs(c.x - cx) / w;
  const dy = Math.abs(c.y - cy) / h;

  return (dx <= tolerance) && (dy <= tolerance);
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
  if(statExpected) statExpected.textContent = mode === 'audit' ? String(expected.size) : '—';
  if(statMatched)  statMatched.textContent  = mode === 'audit' ? String(matchedCount) : '—';
  if(statExtra)    statExtra.textContent    = String(extras.size);
  if(statDup)      statDup.textContent      = String(dupCount);

  if(statMissing){
    if(mode === 'audit'){
      statMissing.textContent = String(Math.max(0, expected.size - matchedCount - handledMissing.size));
    } else {
      statMissing.textContent = '—';
    }
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
      // Update per-box counters
  if (foundCount) {
    foundCount.textContent = `(${scanned.size})`;
  }

  if (extraCount) {
    extraCount.textContent = `(${extras.size})`;
  }

  if (missingCount) {
    if (mode === 'audit') {
      missingCount.textContent = `(${missingQueue.length})`;
    } else {
      missingCount.textContent = '(—)';
    }
  }


    if (copyAllScanned) copyAllScanned.disabled = scanned.size === 0;

    if(mode === 'audit'){
      regenerateMissingQueue();
      copyNextMissing.disabled = missingQueue.length === 0;
      if(copyAllMissing) copyAllMissing.disabled = missingQueue.length === 0;
   } else {
  copyNextMissing.disabled = true;
  if(copyAllMissing) copyAllMissing.disabled = true;
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

  function updateModeButtonsState() {
  const hasTech = techNameField && techNameField.value.trim().length > 0;
  const hasContractor = contractorField && contractorField.value.trim().length > 0;

  const canChooseMode = hasTech && hasContractor;

  if (modeAuditBtn) modeAuditBtn.disabled = !canChooseMode;
  if (modeQuickBtn) modeQuickBtn.disabled = !canChooseMode;
}

  // Export button
function updateExportButtonState() {
  const exportAuditBtn = document.getElementById('exportCsv');
  const exportFullBtn  = document.getElementById('exportFullCsv');

  const hasExpected = expected && expected.size > 0;
  const hasScans = scanned && scanned.size > 0;

  const hasTech = techNameField && techNameField.value.trim().length > 0;
  const hasContractor = contractorField && contractorField.value.trim().length > 0;

  // Export Audit Results (your existing audit export)
  // Keep this strict: audit mode + excel + tech + contractor
  const canExportAudit = (mode === 'audit' && hasExpected && hasTech && hasContractor);

  // Export Full Report (Reference)
  // Works if tech+contractor AND (excel imported OR at least one scan)
  const canExportFull = (hasTech && hasContractor && (hasExpected || hasScans));

  if (exportAuditBtn) exportAuditBtn.disabled = !canExportAudit;
  if (exportFullBtn)  exportFullBtn.disabled  = !canExportFull;
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
      const ld = (li !== undefined) ? formatExcelDateCell(r[li]) : '';
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
// ===== Excel date normalization helper =====
function formatExcelDateCell(v) {
  if (v === null || v === undefined) return '';

  // If SheetJS gives us a real Date object
  if (v instanceof Date && !isNaN(v.getTime())) {
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const dd = String(v.getDate()).padStart(2, '0');
    const yy = v.getFullYear();
    return `${mm}/${dd}/${yy}`;
  }

  // If it's already a readable string, keep it
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return '';
    // Numeric string like "46024"
    if (/^\d+(\.\d+)?$/.test(s)) {
      v = Number(s);
    } else {
      return s;
    }
  }

  // Excel serial date number
  if (typeof v === 'number' && isFinite(v)) {
    const serial = Math.floor(v);
    if (serial > 20000 && serial < 90000) {
      const excelEpoch = new Date(1899, 11, 30);
      const d = new Date(excelEpoch.getTime() + serial * 86400000);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const yy = d.getFullYear();
      return `${mm}/${dd}/${yy}`;
    }
    return String(v);
  }

  return String(v).trim();
}

 excelFile.addEventListener('change', async ()=>{
  const f = excelFile.files && excelFile.files[0];
  if(!f) return;

  fileMeta.textContent = f.name;

  // STEP 1: detect CSV vs Excel
  const lowerName = String(f.name || '').toLowerCase();
  if (lowerName.endsWith('.csv')) {
    setBanner('ok', 'CSV detected — (parsing comes next step)');
    expectedSummary.textContent = 'CSV selected. Next step: import expected serials from CSV.';
    return; // stop here for now
  }

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
    updateExportButtonState();
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
  if(!result || !armed) return;

  const rawText = result.getText();
  let cleaned = normalizeSerial(stripControlChars(rawText));

  // PN labels sometimes include a literal "#" in the encoded text
cleaned = cleaned.replace(/#/g, '');

  // Ignore ultra-short junk decodes silently
  if(!cleaned || cleaned.length < 7){
    return;
  }

  // Reject things that don't look like serials, but stay armed
  if(!looksLikeSerial(cleaned)){
    setBanner('warn', 'Rejected: ' + cleaned);
    // Don’t get “stuck” dwelling on a bad candidate
    lastCandidate = '';
    candidateSince = 0;
    return; // keep scanning
  }

  // Accept the scan
  armed = false;
  hasScannedOnce = true;
  if(armTimeoutId){
    clearTimeout(armTimeoutId);
    armTimeoutId = null;
  }

  scanSuccessSound();
  setPendingScan(cleaned);

  stopCamera().then(()=>{
    startScan.disabled = false;
    startScan.textContent = 'Scan Next';
    stopScan.disabled = !pendingScanText;
    setBanner('ok', 'Scan captured — tap Scan Next to commit');
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
      // Commit any pending Last Scanned BEFORE starting the next scan
    commitPendingIfAny();
    const originalLabel = startScan.textContent;
    startScan.disabled = true;
    startScan.textContent = 'Aim…';
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

      // Arm for exactly one scan, but with a short delay so the user can align the red bar.
      lastCandidate = '';
      candidateSince = 0;
      armed = false;

// Clear any previous timers
if(armDelayId){ clearTimeout(armDelayId); armDelayId = null; }
if(armTimeoutId){ clearTimeout(armTimeoutId); armTimeoutId = null; }

// Small “get ready” delay
startScan.textContent = 'Aim…';

armDelayId = setTimeout(()=>{
  armDelayId = null;
  armed = true;
  startScan.textContent = 'Scanning…';

  if(armDelayId){ clearTimeout(armDelayId); armDelayId = null; }

  // Timeout starts AFTER we arm
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

}, 450);

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
        commitPendingIfAny();
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

 if (copyAllScanned) {
  copyAllScanned.addEventListener('click', (e)=>{
    e.preventDefault();
    e.stopPropagation();

    const arr = Array.from(scanned).sort();
    copyText(arr.join('\n'));
  });
}


  if(copyAllMissing){
  copyAllMissing.addEventListener('click', ()=>{
    if(mode !== 'audit') return;
    regenerateMissingQueue();
    copyText(missingQueue.join('\n'));
  });
}

  copyNextMissing.addEventListener('click', ()=>{
    if(mode !== 'audit') return;
    regenerateMissingQueue();
    if(missingQueue.length === 0) return;
    const next = missingQueue[0];
    handledMissing.add(next);
    copyText(next);
    updateUI();
  });
  // ===== Last Scanned (pending commit) =====
let pendingScanText = ''; // holds scan waiting to be committed

const lastScannedValueEl = document.getElementById('lastScannedValue');
const dismissLastScannedBtn = document.getElementById('dismissLastScanned');
const lastScannedCheckEl = document.getElementById('lastScannedCheck');


function renderLastScannedUI(){
  if(!lastScannedValueEl || !dismissLastScannedBtn) return;
  
    if(pendingScanText){
    lastScannedValueEl.textContent = pendingScanText;
    dismissLastScannedBtn.disabled = false;

    // Allow "Finished" to commit the last pending scan
    if(stopScan) stopScan.disabled = false;
  }else{
    lastScannedValueEl.textContent = 'Nothing scanned yet';
    dismissLastScannedBtn.disabled = true;

    // If camera isn't actively scanning, keep Finished disabled
    // (your existing scan start/stop logic will also control this)
    if(stopScan && !armed) stopScan.disabled = true;
  }
}

function setPendingScan(text){
  pendingScanText = (text || '').trim();
  renderLastScannedUI();
}

function clearPendingScan(){
  pendingScanText = '';
  renderLastScannedUI();
}
function flashLastScannedCheck(){
  if(!lastScannedCheckEl) return;

  // Show the check briefly
  lastScannedCheckEl.hidden = false;

  setTimeout(()=>{
    if(lastScannedCheckEl) lastScannedCheckEl.hidden = true;
  }, 750);
}

// When the user taps Scan/Scan Next, commit the previous pending scan first
function commitPendingIfAny(){
  if(!pendingScanText) return false;

  onSerialScanned(pendingScanText);

  clearPendingScan();        // clears the value + re-renders
  flashLastScannedCheck();   // now the ✔ can appear and stay briefly

  return true;
}

// X button: discard pending scan (do not commit)
if(dismissLastScannedBtn){
  dismissLastScannedBtn.addEventListener('click', ()=>{
    if(!pendingScanText) return;
    clearPendingScan();
    setBanner('ok', 'Last scan discarded');
  });
}

// Initialize the UI on load
renderLastScannedUI();

async function shareOrDownloadCsv(csvText, filename) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });

  // Try Share Sheet first (iOS-friendly: attempt share even if canShare is absent/finicky)
  if (navigator.share) {
    try {
      const file = new File([blob], filename, { type: 'text/csv;charset=utf-8' });

      await navigator.share({
        files: [file],
        title: filename,
        text: 'TAU export',
      });

      return 'share';
    } catch (e) {
      // user cancel or iOS blocks → fall through to download
    }
  }

  // Fallback: download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return 'download';
}



const exportBtn = document.getElementById('exportCsv');

if (exportBtn) {
  exportBtn.addEventListener('click', async () => {
    if (exportBtn.disabled) return;

    // Auditor export only works in Audit mode with an uploaded Excel
    if (mode !== 'audit' || !expected || expected.size === 0) {
      setBanner('warn', 'Upload an Excel file to export missing items.');
      updateExportButtonState();
      return;
    }

    // Make sure Missing is current
    regenerateMissingQueue();

    const techName = techNameField.value.trim();
    const contractorName = contractorField.value.trim();


    // Date (MM/DD/YYYY)
    const d = new Date();
    const auditDate =
      String(d.getMonth() + 1).padStart(2, '0') + '/' +
      String(d.getDate()).padStart(2, '0') + '/' +
      d.getFullYear();

    // Auditor CSV columns:
    // Date, Technician Name, Contractor Name, Serial Number, Equipment Status, Notes
    const rows = [];
    rows.push(['Date','Technician Name','Contractor Name or Garage','Serial Number','Equipment Status','Notes']);

    const tech = techName.trim();
    const contractor = contractorName.trim();

    // Missing-only export; status intentionally set to Installed
    for (const s of missingQueue) {
      rows.push([auditDate, tech, contractor, s, 'Installed', '']);
    }

    // CSV encode
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csv = rows.map(r => r.map(esc).join(',')).join('\n');

    // Filename
    const safeDate = new Date().toISOString().slice(0,10); // YYYY-MM-DD
    const safeTech = tech.replace(/[^A-Za-z0-9_-]+/g, '_');
    const safeContractor = contractor.replace(/[^A-Za-z0-9_-]+/g, '_');
    const filename = `TAU_Auditor_${safeDate}_${safeTech}_${safeContractor}.csv`;
    
    await shareOrDownloadCsv(csv, filename);

  });
}

// ===============================
// Full Report export (XLSX + formatted)
// ===============================

function mmddyyyy(d){
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = d.getFullYear();
  return `${mm}-${dd}-${yy}`;
}

function safeNameForFile(s){
  return String(s || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '');
}

function buildFullReportRows() {
  const now = new Date();
  const auditDate = mmddyyyy(now);

  const tech = (window.techNameField?.value || '').trim();
  const contractor = (window.contractorField?.value || '').trim();

  const rows = [];
  rows.push([
    'Date',
    'Technician Name',
    'Contract Company / Garage',
    'Serial',
    'Part',
    'Quality',
    'Last Date'
  ]);

  // Helper to push a row
  function pushRow(serial, qualityLabel) {
    const rec = expected?.get(serial);
    const part = rec?.part || '';
    const lastDate = rec?.lastDate || '';

    rows.push([
      auditDate,
      tech,
      contractor,
      serial,
      part,
      qualityLabel,
      lastDate
    ]);
  }

  // If Excel is loaded (audit mode with expected list), we can compute Found/Missing/Extra.
  const hasExpected = expected && expected.size > 0;

  if (hasExpected) {
    // Found = scanned ∩ expected
    const found = Array.from(scanned).filter(s => expected.has(s));

    // Missing = expected \ scanned \ handledMissing (matches your current queue logic)
    regenerateMissingQueue();
    const missing = Array.from(missingQueue);

    // Extra = scanned \ expected (you already track extras)
    const extra = Array.from(extras);

    // Sort by serial
    found.sort();
    missing.sort();
    extra.sort();

    for (const s of found)  pushRow(s, 'Found');
    for (const s of missing) pushRow(s, 'Missing');

    // Extras: Part/Last Date blank automatically since not in expected
    for (const s of extra) {
      rows.push([auditDate, tech, contractor, s, '', 'Extra', '']);
    }

  } else {
    // Quick Scan mode (or audit mode with no Excel): everything scanned is "Found"
    const onlyScanned = Array.from(scanned).sort();
    for (const s of onlyScanned) {
      rows.push([auditDate, tech, contractor, s, '', 'Found', '']);
    }
  }

  return rows;
}

function applyFullReportStyles(ws, range) {
  // NOTE: style rendering depends on the SheetJS build, but we set the styles regardless.
  const headerFill = { patternType: "solid", fgColor: { rgb: "0B2A6F" } }; // dark blue
  const headerFont = { color: { rgb: "FFFFFF" }, bold: true };

  const thinBorder = {
    top:    { style: "thin", color: { rgb: "000000" } },
    bottom: { style: "thin", color: { rgb: "000000" } },
    left:   { style: "thin", color: { rgb: "000000" } },
    right:  { style: "thin", color: { rgb: "000000" } },
  };

  const decoded = XLSX.utils.decode_range(range);

  for (let R = decoded.s.r; R <= decoded.e.r; ++R) {
    for (let C = decoded.s.c; C <= decoded.e.c; ++C) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = ws[addr];
      if (!cell) continue;

      const hasValue = cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '';
      if (!hasValue) continue;

      cell.s = cell.s || {};
      cell.s.border = thinBorder;

      if (R === 0) {
        cell.s.fill = headerFill;
        cell.s.font = headerFont;
        cell.s.alignment = { horizontal: "center", vertical: "center", wrapText: true };
      } else {
        cell.s.alignment = { vertical: "center", wrapText: true };
      }
    }
  }

  ws["!rows"] = ws["!rows"] || [];
  ws["!rows"][0] = { hpt: 18 };
}

async function exportFullReportXlsx() {
  const tech = (window.techNameField?.value || '').trim();
  const contractor = (window.contractorField?.value || '').trim();

  if (!tech || !contractor) {
    setBanner('warn', 'Enter Technician Name and Contract Company / Garage first.');
    updateExportButtonState();
    return;
  }

  const hasExpected = expected && expected.size > 0;
  const hasAnyRows =
    (hasExpected) || (scanned && scanned.size > 0);

  if (!hasAnyRows) {
    setBanner('warn', 'Scan at least one item (or upload an Excel file) before exporting.');
    updateExportButtonState();
    return;
  }

  const rows = buildFullReportRows();

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);

  // Auto-width (reasonable)
  const colCount = rows[0].length;
  ws["!cols"] = Array.from({ length: colCount }, (_, c) => {
    let maxLen = 10;
    for (let r = 0; r < rows.length; r++) {
      const v = rows[r][c];
      const len = String(v ?? '').length;
      if (len > maxLen) maxLen = len;
    }
    return { wch: Math.min(45, maxLen + 2) };
  });

  const range = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: rows.length - 1, c: colCount - 1 },
  });
  applyFullReportStyles(ws, range);

  XLSX.utils.book_append_sheet(wb, ws, "Full Report");

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });

  const now = new Date();
  const filename =
    `${safeNameForFile(tech)}_${mmddyyyy(now)}_FullReport.xlsx`;

  // Share sheet first, download fallback
  if (navigator.share) {
    try {
      const file = new File([blob], filename, { type: blob.type });
      await navigator.share({ files: [file], title: filename, text: 'TAU Full Report' });
      return;
    } catch (e) {
      // fall through to download
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Wire the Full Report button
const exportFullBtn = document.getElementById('exportFullCsv');
if (exportFullBtn) {
  exportFullBtn.addEventListener('click', async () => {
    if (exportFullBtn.disabled) return;
    await exportFullReportXlsx();
  });
}

   // PWA install hint
  let deferredPrompt = null;
  const installBtn = $('installBtn');

  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', async ()=>{
      if(!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt = null;
      installBtn.hidden = true;
    });
  }

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
  setIdleBanner();
  banner.className = 'banner';
  banner.textContent = IDLE_BANNER_TEXT;
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

  updateModeButtonsState();

if (techNameField) {
  techNameField.addEventListener('input', () => {
    updateModeButtonsState();
    updateExportButtonState();
  });
}

if (contractorField) {
  contractorField.addEventListener('input', () => {
    updateModeButtonsState();
    updateExportButtonState();
  });
}

})();
