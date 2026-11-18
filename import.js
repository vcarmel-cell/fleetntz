/* Folder import + document attachments. Loaded after the main script; uses its globals (S, db, user, esc, ...). */
const storage = firebase.storage();
const DOCTYPE = {vlicense:'רישיון רכב', insurance:'ביטוח', invoice:'חשבונית / קבלה', fine:'דוח / קנס', dlicense:'רישיון נהיגה', fuel:'דוח דלק', other:'אחר'};
const SHEET_EXT = /\.(xlsx|xlsm|xls|csv)$/i, DOC_EXT = /\.(pdf|jpe?g|png|webp)$/i;
const fmtSize = n => n > 1048576 ? nf1.format(n/1048576)+' MB' : nf.format(Math.max(1,n/1024))+' KB';
const digits = s => String(s ?? '').replace(/\D/g, '');
const vehByPlate = p => { const d = digits(p); return d ? S.vehicles.find(v => digits(v.plate) === d) : null; };

/* ================= documents attached to vehicles / drivers ================= */
async function uploadDoc(file, ownerType, ownerId, docType, source){
  const safe = file.name.replace(/[^\w.\-֐-׿ ]+/g, '_').slice(-120);
  const path = `docs/${ownerType}/${ownerId}/${Date.now()}_${safe}`;
  const ref = storage.ref(path);
  await ref.put(file, {contentType: file.type || 'application/octet-stream'});
  const url = await ref.getDownloadURL();
  await db.collection('documents').add({ownerType, ownerId, docType: docType||'other', name:file.name, path, url,
    size:file.size, contentType:file.type||'', date: today(), source: source||'manual', ...stamp(),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()});
}
function docsSection(ownerType, ownerId){
  const rows = S.documents.filter(d => d.ownerType===ownerType && d.ownerId===ownerId).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const types = ownerType==='d' ? ['dlicense','fine','other'] : ['vlicense','insurance','invoice','fine','other'];
  return `<h3>מסמכים (${rows.length})</h3>
    <div class="toolbar">
      <select id="upType" style="max-width:200px">${types.map(t=>`<option value="${t}">${DOCTYPE[t]}</option>`).join('')}</select>
      <label class="btn">צירוף קבצים<input type="file" multiple accept=".pdf,image/*" data-up="${ownerType}:${ownerId}" hidden></label>
      <span class="sub" id="upMsg"></span>
    </div>
    ${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>מסמך</th><th>סוג</th><th>תאריך</th><th class="num">גודל</th><th></th></tr></thead><tbody>
      ${rows.map(d=>`<tr><td class="wrap"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a></td>
        <td><select data-doctype="${d.id}" style="width:auto;padding:4px 6px">${Object.entries(DOCTYPE).map(([k,t])=>`<option value="${k}" ${k===d.docType?'selected':''}>${t}</option>`).join('')}</select></td>
        <td>${fmtD(d.date)}</td><td class="num">${fmtSize(d.size||0)}</td>
        <td><button class="btn sm danger" data-docdel="${d.id}">מחיקה</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="tbl-wrap"><div class="empty">אין מסמכים מצורפים</div></div>'}`;
}
async function deleteDoc(id){
  const d = byId('documents', id); if (!d || !confirm(`למחוק את המסמך "${d.name}"?`)) return;
  try { await storage.ref(d.path).delete(); } catch(e){ if (e.code !== 'storage/object-not-found') throw e; }
  await db.collection('documents').doc(id).delete(); toast('המסמך נמחק');
}
$('#cBody').addEventListener('change', async e => {
  const up = e.target.closest('[data-up]'), dt = e.target.closest('[data-doctype]');
  if (dt){ await db.collection('documents').doc(dt.dataset.doctype).update({docType: dt.value, ...stamp()}); toast('עודכן'); return; }
  if (!up || !up.files.length) return;
  const [ot, oid] = up.dataset.up.split(':'), type = $('#upType').value, files = [...up.files];
  let n = 0;
  for (const f of files){
    if (f.size > 20*1048576){ toast(`${f.name} גדול מ-20MB — דולג`); continue; }
    $('#upMsg').textContent = `מעלה ${++n} מתוך ${files.length}…`;
    try { await uploadDoc(f, ot, oid, type, 'manual'); } catch(err){ console.error(err); toast('שגיאה בהעלאה: '+err.message); }
  }
  toast('הקבצים צורפו'); refreshCard();
});
$('#cBody').addEventListener('click', e => { const b = e.target.closest('[data-docdel]'); if (b) deleteDoc(b.dataset.docdel).then(refreshCard).catch(err=>toast('שגיאה: '+err.message)); });

/* ================= folder import ================= */
document.body.insertAdjacentHTML('beforeend', `
<dialog id="impDlg" class="wide">
  <div class="dlg-head" id="iTitle">ייבוא מתיקייה</div>
  <div class="dlg-body" id="iBody"></div>
  <div class="dlg-foot" id="iFoot"></div>
</dialog>`);
const impBtn = document.createElement('button');
impBtn.className = 'btn'; impBtn.id = 'importBtn'; impBtn.textContent = 'ייבוא מתיקייה';
impBtn.title = 'ייבוא רשימות אקסל ומסמכים מתיקייה במחשב';
$('#backupBtn').before(impBtn);
impBtn.onclick = () => impStart();

let IMP = {files:[], sheet:null};
function impShow(title, body, foot){ $('#iTitle').textContent = title; $('#iBody').innerHTML = body; $('#iFoot').innerHTML = foot; if (!$('#impDlg').open) $('#impDlg').showModal(); }
const closeBtn = '<button class="btn" type="button" data-iclose>סגירה</button>';
$('#impDlg').addEventListener('click', e => { if (e.target.closest('[data-iclose]')) $('#impDlg').close(); });

function impStart(){
  impShow('ייבוא מתיקייה', `
    <p>בחר תיקייה במחשב. המערכת תסרוק את הקבצים שבה (כולל תתי-תיקיות) ותציג מה ניתן לייבא — שום דבר לא יישמר לפני אישור.</p>
    <ul class="sub" style="line-height:1.9">
      <li><b>אקסל / CSV</b> — רשימות רכבים, נהגים, דוחות חברת הדלק, הוצאות וטיפולים</li>
      <li><b>PDF ותמונות</b> — רישיונות רכב, ביטוחים, חשבוניות ודוחות, לצירוף לרכב המתאים</li>
    </ul>
    <div class="toolbar" style="margin-top:14px">
      <button class="btn primary" id="iPickDir">בחירת תיקייה</button>
      <label class="btn">או בחירת קבצים<input type="file" id="iPickFiles" multiple hidden accept=".xlsx,.xlsm,.xls,.csv,.pdf,image/*"></label>
      <input type="file" id="iPickDirFallback" webkitdirectory multiple hidden>
    </div>`, closeBtn);
  $('#iPickDir').onclick = async () => {
    if (!window.showDirectoryPicker){ $('#iPickDirFallback').click(); return; }
    try { const dir = await window.showDirectoryPicker({mode:'read'}); impScan(await walk(dir, '', 0)); }
    catch(e){ if (e.name !== 'AbortError') toast('לא ניתן לקרוא את התיקייה: '+e.message); }
  };
  $('#iPickFiles').onchange = e => impScan([...e.target.files].map(f=>({file:f, path:f.name})));
  $('#iPickDirFallback').onchange = e => impScan([...e.target.files].map(f=>({file:f, path:f.webkitRelativePath||f.name})));
}
async function walk(dir, prefix, depth){
  const out = [];
  for await (const [name, h] of dir.entries()){
    if (name.startsWith('.') || name.startsWith('~$')) continue;
    if (h.kind === 'file'){ if (SHEET_EXT.test(name) || DOC_EXT.test(name)) out.push({file: await h.getFile(), path: prefix+name}); }
    else if (depth < 4) out.push(...await walk(h, prefix+name+'/', depth+1));
  }
  return out;
}
function guessDocType(name){
  const n = name.toLowerCase();
  if (/רישיון רכב|רשיון רכב|רישוי|טסט|license/.test(n)) return 'vlicense';
  if (/ביטוח|פוליסה|insurance|policy/.test(n)) return 'insurance';
  if (/דוח|קנס|ticket|fine/.test(n)) return 'fine';
  if (/רישיון נהיגה|רשיון נהיגה/.test(n)) return 'dlicense';
  if (/חשבונית|קבלה|מוסך|invoice|receipt/.test(n)) return 'invoice';
  return 'other';
}
function guessVehicle(path){
  for (const m of path.replace(/[-\s.]/g,'').match(/\d{7,8}/g) || []){ const v = vehByPlate(m); if (v) return v.id; }
  return '';
}
function impScan(list){
  IMP.files = list;
  const sheets = list.filter(x => SHEET_EXT.test(x.path)), docs = list.filter(x => DOC_EXT.test(x.path));
  IMP.docs = docs.map(x => ({...x, vehicleId: guessVehicle(x.path), docType: guessDocType(x.path), on: true}));
  const vOpts = vehOpts('— בחר רכב —', true);
  impShow('ייבוא מתיקייה', `
    <div class="hint">נמצאו ${sheets.length} קובצי אקסל / CSV ו-${docs.length} מסמכים (PDF / תמונות).</div>
    <h3>קובצי אקסל / CSV</h3>
    ${sheets.length ? `<div class="tbl-wrap"><table><thead><tr><th>קובץ</th><th class="num">גודל</th><th></th></tr></thead><tbody>
      ${sheets.map((x,i)=>`<tr><td class="wrap">${esc(x.path)}</td><td class="num">${fmtSize(x.file.size)}</td>
        <td><button class="btn sm primary" data-isheet="${IMP.files.indexOf(x)}">ייבוא נתונים</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="tbl-wrap"><div class="empty">אין קובצי אקסל בתיקייה</div></div>'}
    <h3>מסמכים לצירוף</h3>
    ${docs.length ? `<p class="sub">המערכת ניחשה את הרכב לפי מספר רישוי בשם הקובץ או התיקייה, ואת סוג המסמך לפי שם הקובץ. בדוק ותקן לפני הצירוף.</p>
      <div class="tbl-wrap"><table><thead><tr><th><input type="checkbox" id="iAllDocs" checked aria-label="בחירת הכל"></th><th>קובץ</th><th>רכב</th><th>סוג</th><th class="num">גודל</th></tr></thead><tbody>
      ${IMP.docs.map((d,i)=>`<tr><td><input type="checkbox" data-idon="${i}" ${d.on?'checked':''} aria-label="לצרף"></td>
        <td class="wrap">${esc(d.path)}</td>
        <td><select data-idveh="${i}" style="min-width:190px">${vOpts.map(o=>`<option value="${o.v}" ${o.v===d.vehicleId?'selected':''}>${esc(o.t)}</option>`).join('')}</select></td>
        <td><select data-idtype="${i}">${Object.entries(DOCTYPE).map(([k,t])=>`<option value="${k}" ${k===d.docType?'selected':''}>${t}</option>`).join('')}</select></td>
        <td class="num">${fmtSize(d.file.size)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="toolbar"><button class="btn primary" id="iAttach">צירוף המסמכים המסומנים</button><span class="sub" id="iAttMsg"></span></div>
      <p class="sub">שליפה אוטומטית של נתונים מתוך ה-PDF (תוקף, סכומים, מוסך) תתווסף בשלב הבא.</p>`
    : '<div class="tbl-wrap"><div class="empty">אין מסמכים בתיקייה</div></div>'}`,
    `<button class="btn" type="button" id="iBack">בחירת תיקייה אחרת</button>${closeBtn}`);
  $('#iBack').onclick = impStart;
}
$('#iBody').addEventListener('change', e => {
  const t = e.target, ds = t.dataset;
  if (ds.idon) IMP.docs[ds.idon].on = t.checked;
  if (ds.idveh) IMP.docs[ds.idveh].vehicleId = t.value;
  if (ds.idtype) IMP.docs[ds.idtype].docType = t.value;
  if (t.id === 'iAllDocs'){ IMP.docs.forEach(d=>d.on=t.checked); document.querySelectorAll('[data-idon]').forEach(c=>c.checked=t.checked); }
});
$('#iBody').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.isheet) return impSheet(IMP.files[+b.dataset.isheet]);
  if (b.id === 'iAttach'){
    const sel = IMP.docs.filter(d => d.on);
    if (!sel.length) return toast('לא נבחרו מסמכים');
    if (sel.some(d => !d.vehicleId)) return toast('יש מסמכים מסומנים ללא רכב — בחר רכב או בטל את הסימון');
    b.disabled = true; let n = 0, fail = 0;
    for (const d of sel){
      $('#iAttMsg').textContent = `מעלה ${++n} מתוך ${sel.length}…`;
      if (d.file.size > 20*1048576){ fail++; continue; }
      try { await uploadDoc(d.file, 'v', d.vehicleId, d.docType, 'folder'); d.on = false; d.done = true; } catch(err){ console.error(err); fail++; }
    }
    $('#iAttMsg').textContent = `צורפו ${n-fail} מסמכים` + (fail ? ` · ${fail} נכשלו` : '');
    IMP.docs = IMP.docs.filter(d => !d.done);
    toast('המסמכים צורפו'); b.disabled = false;
  }
});

/* ---------- spreadsheet import ---------- */
const TARGETS = {
  vehicles: {label:'רכבים', fields:[
    ['plate','מספר רישוי',1],['make','יצרן'],['model','דגם'],['year','שנת ייצור','n'],['color','צבע'],['km','קילומטראז\'','n'],
    ['licenseExpiry','טסט בתוקף עד','d'],['insuranceExpiry','ביטוח חובה עד','d'],['compExpiry','ביטוח מקיף עד','d'],['leaseCompany','חברת ליסינג / בעלים'],['notes','הערות']]},
  drivers: {label:'נהגים', fields:[
    ['name','שם',1],['idNumber','ת"ז / מס\' עובד'],['phone','טלפון'],['email','אימייל'],['department','מחלקה'],
    ['licenseNumber','מספר רישיון נהיגה'],['licenseClass','דרגת רישיון'],['licenseExpiry','תוקף רישיון נהיגה','d'],['notes','הערות']]},
  expenses: {label:'דלק והוצאות', fields:[
    ['date','תאריך',1,'d'],['plate','מספר רישוי',1],['amount','סכום',1,'n'],['category','סוג הוצאה / מוצר'],['liters','ליטרים / כמות','n'],
    ['km','קילומטראז\'','n'],['supplier','תחנה / ספק'],['driver','שם נהג'],['notes','הערות']]},
  services: {label:'טיפולים ותיקונים', fields:[
    ['date','תאריך',1,'d'],['plate','מספר רישוי',1],['cost','עלות','n'],['type','סוג טיפול'],['km','קילומטראז\'','n'],
    ['garage','מוסך'],['description','תיאור'],['invoice','מספר חשבונית']]}
};
const SYN = {
  plate:['מספר רישוי','מס רישוי','מספר רכב','מס רכב','מספר הרכב','לוחית רישוי','רישוי','plate','license plate','car number'],
  make:['יצרן','תוצר','make','manufacturer'], model:['דגם','תאור דגם','model'], year:['שנת ייצור','שנת יצור','שנתון','year'],
  color:['צבע','color'], km:['קילומטראז','קילומטרז','מד אוץ','מונה','ק"מ','odometer','mileage','km'],
  licenseExpiry:['תוקף רישיון רכב','רישיון רכב','תוקף רישוי','טסט','תוקף טסט'], insuranceExpiry:['ביטוח חובה','חובה עד','תוקף חובה'],
  compExpiry:['ביטוח מקיף','מקיף'], leaseCompany:['חברת ליסינג','ליסינג','בעלים'],
  name:['שם מלא','שם הנהג','שם נהג','שם העובד','שם עובד','שם','name','driver name'], idNumber:['תעודת זהות','ת"ז','מספר עובד','מס עובד','id'],
  phone:['טלפון נייד','נייד','טלפון','פלאפון','phone','mobile'], email:['אימייל','דוא"ל','מייל','email'], department:['מחלקה','ענף','אגף','department'],
  licenseNumber:['מספר רישיון נהיגה','מספר רישיון','מס רישיון'], licenseClass:['דרגת רישיון','דרגה','סוג רישיון'],
  date:['תאריך עסקה','תאריך תדלוק','תאריך','date'], amount:['סכום לחיוב','סכום כולל','סה"כ לתשלום','סה"כ','סכום','לתשלום','מחיר','amount','total'],
  cost:['עלות','סכום','סה"כ','מחיר','לתשלום','cost','amount','total'],
  category:['סוג הוצאה','סוג מוצר','סוג דלק','מוצר','סוג','category','product'], liters:['ליטרים','ליטר','כמות','liters','quantity','qty'],
  supplier:['שם תחנה','תחנה','בית עסק','ספק','station','merchant'], driver:['שם נהג','שם הנהג','נהג','driver'],
  type:['סוג טיפול','סוג','type'], garage:['מוסך','ספק','garage'], description:['תיאור','פירוט','description'], invoice:['מספר חשבונית','חשבונית','invoice'],
  notes:['הערות','notes'], dLicenseExpiry:['תוקף רישיון נהיגה','תוקף רישיון','רישיון בתוקף עד']
};
const norm = s => String(s ?? '').toLowerCase().replace(/["'`׳״.,:\-_/()]/g,'').replace(/\s+/g,' ').trim();
function synFor(target, key){ return (target==='drivers' && key==='licenseExpiry') ? SYN.dLicenseExpiry : (SYN[key]||[]); }
function autoMap(target, headers){
  const nh = headers.map(norm), used = new Set(), map = {};
  for (const [key] of TARGETS[target].fields){
    let best = -1, bestScore = 0;
    synFor(target, key).forEach((syn, si) => { const ns = norm(syn);
      nh.forEach((h, ci) => { if (used.has(ci) || !h) return;
        const sc = h===ns ? 100-si : (h.includes(ns) && ns.length>=2 ? 50-si+ns.length/10 : 0);
        if (sc > bestScore){ bestScore = sc; best = ci; } }); });
    if (best >= 0){ map[key] = best; used.add(best); }
  }
  return map;
}
function guessTarget(headers){
  let best = 'expenses', bestN = -1;
  for (const t of Object.keys(TARGETS)){
    const m = autoMap(t, headers), req = TARGETS[t].fields.filter(f=>f[2]===1).map(f=>f[0]);
    const n = Object.keys(m).length + (req.every(k=>k in m) ? 3 : 0) - (t==='services' ? 0.5 : 0);
    if (n > bestN){ bestN = n; best = t; }
  }
  return best;
}
function headerRow(rows){
  const all = Object.values(SYN).flat().map(norm);
  let best = 0, bestN = -1;
  rows.slice(0, 15).forEach((r, i) => { const n = r.filter(c => { const h = norm(c); return h && all.some(s => h===s || (s.length>2 && h.includes(s))); }).length; if (n > bestN){ bestN = n; best = i; } });
  return best;
}
function parseDate(v){
  if (v === '' || v == null) return '';
  if (typeof v === 'number' && v > 20000 && v < 80000){ const p = XLSX.SSF.parse_date_code(v); return p ? `${p.y}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')}` : ''; }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m){ let y = +m[3]; if (y < 100) y += 2000; const d = +m[1], mo = +m[2]; if (mo>=1 && mo<=12 && d>=1 && d<=31) return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
  return null;
}
function parseNum(v){
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[^\d.\-]/g, ''); if (!s) return null;
  const n = Number(s); return isFinite(n) ? n : NaN;
}
function guessCategory(v, def){
  const s = String(v||'');
  if (/חשמל|טעינה|charg|kwh/i.test(s)) return 'charge';
  if (/דלק|בנזין|סולר|דיזל|95|98|fuel|diesel|petrol/i.test(s)) return 'fuel';
  if (/כביש ?6|אגרה|נתיב|מנהרות|toll/i.test(s)) return 'toll';
  if (/חני|פנגו|סלופארק|parking/i.test(s)) return 'parking';
  if (/דוח|קנס|fine/i.test(s)) return 'fine';
  if (/שטיפ|wash/i.test(s)) return 'wash';
  const k = Object.entries(ECAT).find(([,t]) => s && s.includes(t)); return k ? k[0] : def;
}
function guessSType(v){
  const s = String(v||'');
  if (/צמיג/.test(s)) return 'tires'; if (/טסט|מבחן רישוי/.test(s)) return 'test'; if (/פחח|תאונ|צבע/.test(s)) return 'body';
  if (/תיקון|תקלה/.test(s)) return 'repair'; if (/טיפול|שמן|תקופתי/.test(s) || !s) return 'periodic'; return 'other';
}
const mapKey = (t, headers) => 'fleet.map.' + t + '.' + headers.map(norm).join('|').slice(0, 300);

async function impSheet(entry){
  try {
    const buf = await entry.file.arrayBuffer();
    let wb;
    if (/\.csv$/i.test(entry.path)){
      let text; try { text = new TextDecoder('utf-8', {fatal:true}).decode(buf); } catch(_){ text = new TextDecoder('windows-1255').decode(buf); }
      wb = XLSX.read(text.replace(/^﻿/, ''), {type:'string', raw:true});
    } else wb = XLSX.read(buf, {type:'array', cellDates:false});
    IMP.sheet = {entry, wb, sheetName: wb.SheetNames.find(n => (XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1}).length > 1)) || wb.SheetNames[0]};
    impLoadSheet(); impMapping();
  } catch(err){ console.error(err); toast('לא ניתן לקרוא את הקובץ: '+err.message); }
}
function impLoadSheet(target){
  const sh = IMP.sheet, rows = XLSX.utils.sheet_to_json(sh.wb.Sheets[sh.sheetName], {header:1, raw:true, defval:''});
  const hr = headerRow(rows), headers = (rows[hr]||[]).map((h,i) => String(h).trim() || `עמודה ${i+1}`);
  sh.headers = headers;
  sh.data = rows.slice(hr+1).filter(r => r.some(c => String(c).trim() !== ''));
  sh.target = target || guessTarget(headers);
  let saved = null; try { saved = JSON.parse(localStorage.getItem(mapKey(sh.target, headers))); } catch(_){}
  sh.map = saved || autoMap(sh.target, headers);
  sh.defCat = sh.defCat || 'fuel';
}
function impMapping(){
  const sh = IMP.sheet, T = TARGETS[sh.target];
  const colOpts = sel => `<option value="">— לא לייבא —</option>` + sh.headers.map((h,i)=>`<option value="${i}" ${String(sel)===String(i)?'selected':''}>${esc(h)}</option>`).join('');
  const sample = sh.data.slice(0, 3);
  impShow('ייבוא: ' + sh.entry.path, `
    <div class="toolbar">
      ${sh.wb.SheetNames.length > 1 ? `<label class="dt">גיליון <select id="iSheet" style="min-width:160px">${sh.wb.SheetNames.map(n=>`<option ${n===sh.sheetName?'selected':''}>${esc(n)}</option>`).join('')}</select></label>` : ''}
      <label class="dt">סוג הנתונים <select id="iTarget" style="min-width:180px">${Object.entries(TARGETS).map(([k,t])=>`<option value="${k}" ${k===sh.target?'selected':''}>${t.label}</option>`).join('')}</select></label>
      ${sh.target==='expenses' ? `<label class="dt">סוג ברירת מחדל <select id="iDefCat">${Object.entries(ECAT).map(([k,t])=>`<option value="${k}" ${k===sh.defCat?'selected':''}>${t}</option>`).join('')}</select></label>` : ''}
      <span class="sp"></span><span class="sub">${sh.data.length} שורות נתונים</span>
    </div>
    <div class="hint">התאם כל שדה במערכת לעמודה בקובץ. ההתאמה נשמרת, ובפעם הבאה שתייבא קובץ באותו מבנה היא תיטען אוטומטית.</div>
    <div class="tbl-wrap"><table><thead><tr><th>שדה במערכת</th><th>עמודה בקובץ</th><th>דוגמה</th></tr></thead><tbody>
      ${T.fields.map(([k,label,req])=>`<tr><td>${esc(label)}${req===1?' *':''}</td>
        <td><select data-imap="${k}" style="min-width:200px">${colOpts(sh.map[k])}</select></td>
        <td class="sub">${sample.map(r => sh.map[k]!=null && sh.map[k]!=='' ? esc(String(r[sh.map[k]]).slice(0,30)) : '').filter(Boolean).join(' · ')}</td></tr>`).join('')}
    </tbody></table></div>`,
    `<button class="btn primary" type="button" id="iPreview">המשך לתצוגה מקדימה</button><button class="btn" type="button" id="iBackList">חזרה</button>${closeBtn}`);
  $('#iBackList').onclick = () => impScan(IMP.files);
  $('#iPreview').onclick = () => {
    const miss = T.fields.filter(f => f[2]===1 && (sh.map[f[0]]==null || sh.map[f[0]]==='')).map(f=>f[1]);
    if (miss.length) return toast('חסרה התאמה לשדות חובה: ' + miss.join(', '));
    try { localStorage.setItem(mapKey(sh.target, sh.headers), JSON.stringify(sh.map)); } catch(_){}
    impPreview();
  };
}
$('#iBody').addEventListener('change', e => {
  const sh = IMP.sheet, t = e.target; if (!sh) return;
  if (t.dataset.imap){ sh.map[t.dataset.imap] = t.value === '' ? '' : +t.value; impMapping(); }
  if (t.id === 'iTarget'){ impLoadSheet(t.value); impMapping(); }
  if (t.id === 'iSheet'){ sh.sheetName = t.value; impLoadSheet(); impMapping(); }
  if (t.id === 'iDefCat'){ sh.defCat = t.value; }
  if (t.dataset.irow){ sh.rows[+t.dataset.irow].on = t.checked; impCount(); }
  if (t.id === 'iCreateVeh'){ sh.createVeh = t.checked; impPreview(); }
});

/* build normalized records + status for each row */
function impBuild(){
  const sh = IMP.sheet, m = sh.map, T = sh.target;
  const get = (r, k) => (m[k]==='' || m[k]==null) ? '' : r[m[k]];
  const seen = new Set(), out = [];
  const newPlates = new Set();
  sh.data.forEach((r, i) => {
    const rec = {}, errs = [];
    for (const [k, , req, kind0] of TARGETS[T].fields){
      const kind = kind0 || (req!==1 ? req : ''), raw = get(r, k);
      let v = raw;
      if (kind === 'd'){ v = parseDate(raw); if (v === null){ errs.push('תאריך לא תקין'); v = ''; } }
      else if (kind === 'n'){ v = parseNum(raw); if (Number.isNaN(v)){ errs.push('מספר לא תקין'); v = null; } }
      else v = String(raw ?? '').trim();
      if (req === 1 && (v === '' || v == null)) errs.push('חסר ' + TARGETS[T].fields.find(f=>f[0]===k)[1]);
      rec[k] = v;
    }
    let status = 'new', note = '', ref = null;
    if (T === 'vehicles'){
      ref = vehByPlate(rec.plate); const key = digits(rec.plate);
      if (seen.has(key)){ status = 'dup'; note = 'כפול בקובץ'; } else if (ref){ status = 'upd'; note = 'יעודכן'; }
      seen.add(key);
    } else if (T === 'drivers'){
      ref = S.drivers.find(d => (rec.idNumber && d.idNumber && digits(d.idNumber)===digits(rec.idNumber)) || norm(d.name)===norm(rec.name));
      const key = norm(rec.name);
      if (seen.has(key)){ status = 'dup'; note = 'כפול בקובץ'; } else if (ref){ status = 'upd'; note = 'יעודכן'; }
      seen.add(key);
    } else {
      const v = vehByPlate(rec.plate);
      rec.vehicleId = v ? v.id : '';
      if (!v && rec.plate && !errs.length){
        if (sh.createVeh){ newPlates.add(digits(rec.plate)); note = 'רכב חדש ייווצר'; }
        else { status = 'nov'; note = 'רכב לא קיים במערכת'; }
      }
      if (T === 'expenses'){
        rec.category = m.category!=='' && m.category!=null ? guessCategory(rec.category, sh.defCat) : sh.defCat;
        if (rec.driver){ const d = S.drivers.find(x => norm(x.name)===norm(rec.driver)); rec.driverId = d ? d.id : ''; }
        const key = [digits(rec.plate), rec.date, rec.amount, rec.category, rec.liters].join('|');
        const exists = v && S.expenses.some(e => e.vehicleId===v.id && e.date===rec.date && Number(e.amount)===Number(rec.amount) && e.category===rec.category);
        if (seen.has(key) && status==='new'){ status = 'dup'; note = 'כפול בקובץ'; }
        else if (exists){ status = 'dup'; note = 'כבר קיים במערכת'; }
        seen.add(key);
      } else {
        rec.type = guessSType(rec.type);
        const exists = v && S.services.some(s => s.vehicleId===v.id && s.date===rec.date && Number(s.cost||0)===Number(rec.cost||0));
        if (exists){ status = 'dup'; note = 'כבר קיים במערכת'; }
      }
    }
    if (errs.length){ status = 'err'; note = errs.join(', '); }
    out.push({i, rec, status, note, ref, on: status==='new' || status==='upd'});
  });
  sh.newPlates = newPlates;
  return out;
}
const STAT = {new:['חדש','ok'], upd:['עדכון','blue'], dup:['כפול','neu'], nov:['רכב חסר','warn'], err:['שגיאה','bad']};
function impPreview(){
  const sh = IMP.sheet; sh.rows = impBuild();
  const T = TARGETS[sh.target], cols = T.fields.filter(f => sh.map[f[0]]!=='' && sh.map[f[0]]!=null);
  const cnt = s => sh.rows.filter(r=>r.status===s).length;
  const show = sh.rows.slice(0, 400);
  const cell = (k, v) => k==='plate' ? `<span class="plate">${esc(v)}</span>` : k==='category' ? esc(ECAT[v]||v) : k==='type' && sh.target==='services' ? esc(STYPE[v]||v)
    : /date|Expiry/.test(k) ? fmtD(v) : (typeof v === 'number') ? nf1.format(v) : esc(v);
  impShow('תצוגה מקדימה: ' + sh.entry.path, `
    <div class="toolbar">
      ${Object.entries(STAT).map(([k,[t,c]]) => cnt(k) ? `<span class="tag ${c}">${t}: ${cnt(k)}</span>` : '').join(' ')}
      ${(sh.target==='expenses'||sh.target==='services') && (cnt('nov') || sh.createVeh) ? `<label class="dt"><input type="checkbox" id="iCreateVeh" ${sh.createVeh?'checked':''}> ליצור אוטומטית רכבים שלא קיימים</label>` : ''}
      <span class="sp"></span><span class="sub" id="iCount"></span>
    </div>
    <div class="tbl-wrap" style="max-height:52vh;overflow:auto"><table><thead><tr><th></th><th>מצב</th>${cols.map(f=>`<th>${esc(f[1])}</th>`).join('')}</tr></thead><tbody>
      ${show.map((r, j) => `<tr><td><input type="checkbox" data-irow="${j}" ${r.on?'checked':''} ${r.status==='err'||r.status==='nov'?'disabled':''} aria-label="לייבא שורה"></td>
        <td><span class="tag ${STAT[r.status][1]}">${STAT[r.status][0]}</span>${r.note && r.status!=='new' ? `<div class="sub">${esc(r.note)}</div>` : ''}</td>
        ${cols.map(f => `<td>${cell(f[0], r.rec[f[0]])}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    ${sh.rows.length > 400 ? `<p class="sub">מוצגות 400 השורות הראשונות מתוך ${sh.rows.length}. כל השורות המסומנות כ"חדש" / "עדכון" ייובאו.</p>` : ''}
    ${sh.target==='expenses' ? '<p class="sub">הוצאות ללא שם נהג ישויכו אוטומטית לנהג שהחזיק ברכב בתאריך ההוצאה.</p>' : ''}`,
    `<button class="btn primary" type="button" id="iCommit">ייבוא</button><button class="btn" type="button" id="iBackMap">חזרה להתאמת עמודות</button>${closeBtn}`);
  impCount();
  $('#iBackMap').onclick = impMapping;
  $('#iCommit').onclick = impCommit;
}
function impCount(){ const n = IMP.sheet.rows.filter(r=>r.on).length; $('#iCount').textContent = `${n} שורות ייובאו`; $('#iCommit').disabled = !n; }

async function impCommit(){
  const sh = IMP.sheet, T = sh.target, sel = sh.rows.filter(r => r.on);
  if (!sel.length || !confirm(`לייבא ${sel.length} שורות?`)) return;
  $('#iCommit').disabled = true;
  const clean = o => Object.fromEntries(Object.entries(o).filter(([,v]) => v !== '' && v != null));
  const ops = [];
  try {
    if (T === 'vehicles'){
      sel.forEach(({rec, ref}) => { const o = clean(rec); if (o.km != null) o.kmDate = today();
        ops.push(ref ? [db.collection('vehicles').doc(ref.id), o, true] : [db.collection('vehicles').doc(), {status:'active', fuel:'petrol', ownership: o.leaseCompany ? 'leasing' : 'owned', ...o}, false]); });
    } else if (T === 'drivers'){
      sel.forEach(({rec, ref}) => { const o = clean(rec); ops.push(ref ? [db.collection('drivers').doc(ref.id), o, true] : [db.collection('drivers').doc(), {active:true, ...o}, false]); });
    } else {
      const created = {};
      for (const p of sh.newPlates){
        const raw = sel.find(r => digits(r.rec.plate)===p); if (!raw) continue;
        const ref = db.collection('vehicles').doc(); created[p] = ref.id;
        ops.push([ref, {plate: raw.rec.plate, make:'', status:'active', fuel:'petrol', ownership:'owned', notes:'נוצר בייבוא — יש להשלים פרטים'}, false]);
      }
      const maxKm = {};
      sel.forEach(({rec}) => {
        const vehicleId = rec.vehicleId || created[digits(rec.plate)]; if (!vehicleId) return;
        if (rec.km && rec.km > (maxKm[vehicleId]||0)) maxKm[vehicleId] = rec.km;
        if (T === 'expenses'){
          const o = clean({vehicleId, date:rec.date, category:rec.category, amount:rec.amount, liters:rec.liters, km:rec.km, supplier:rec.supplier, notes:rec.notes,
            driverId: rec.driverId || driverAt(vehicleId, rec.date), paid: rec.category==='fine' ? false : null, source:'import:'+sh.entry.path});
          ops.push([db.collection('expenses').doc(), o, false]);
        } else {
          const o = clean({vehicleId, date:rec.date, type:rec.type, cost:rec.cost, km:rec.km, garage:rec.garage, description:rec.description, invoice:rec.invoice, source:'import:'+sh.entry.path});
          ops.push([db.collection('services').doc(), o, false]);
        }
      });
      Object.entries(maxKm).forEach(([id, k]) => { const v = byId('vehicles', id); if (!v || k > (v.km||0)) ops.push([db.collection('vehicles').doc(id), {km:k, kmDate: today()}, true]); });
    }
    for (let i = 0; i < ops.length; i += 400){
      const b = db.batch();
      ops.slice(i, i+400).forEach(([ref, data, merge]) => b.set(ref, {...data, ...stamp(), ...(merge ? {} : {createdAt: firebase.firestore.FieldValue.serverTimestamp()})}, {merge}));
      await b.commit();
      $('#iCount').textContent = `נשמר ${Math.min(i+400, ops.length)} מתוך ${ops.length}…`;
    }
    toast(`יובאו ${sel.length} שורות`);
    impShow('הייבוא הושלם', `<div class="hint">יובאו ${sel.length} שורות ל${TARGETS[T].label}.${sh.newPlates.size ? ` נוצרו ${sh.newPlates.size} רכבים חדשים — יש להשלים את פרטיהם בלשונית רכבים.` : ''}</div>`,
      `<button class="btn primary" type="button" id="iMore">ייבוא קובץ נוסף מהתיקייה</button>${closeBtn}`);
    $('#iMore').onclick = () => impScan(IMP.files);
  } catch(err){ console.error(err); toast('שגיאה בייבוא: '+err.message); $('#iCommit').disabled = false; }
}
