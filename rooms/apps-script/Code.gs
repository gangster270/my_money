/**
 * 회의실 예약 — Google 스프레드시트 백엔드
 * ------------------------------------------------------------------
 * 이 파일을 Google Apps Script 프로젝트에 붙여넣고 «웹 앱»으로 배포하면
 * 스프레드시트가 공용 예약 데이터베이스가 됩니다. (설치 방법은 rooms/README.md)
 *
 * 안전장치
 *  - LockService 로 동시 예약을 막아, 두 부서가 같은 시간을 동시에 눌러도
 *    한 건만 저장됩니다.
 *  - 취소 비밀번호는 서버에서 검증합니다(브라우저를 못 믿어도 됨).
 *  - 비밀번호는 원문이 아니라 해시만 저장됩니다.
 */

var SHEET_BOOKINGS = 'bookings';
var SHEET_CONFIG   = 'config';
var HEADERS = ['id','roomId','date','start','end','dept','name','title','count','memo','pinHash','createdAt'];

/* ────────────────── 진입점 ────────────────── */

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json({ ok: false, error: '요청을 해석할 수 없습니다.' });
  }
  try {
    switch (req.action) {
      case 'getConfig': return json({ ok: true, data: getConfig_() });
      case 'setConfig': return json({ ok: true, data: setConfig_(req.config, req.pin) });
      case 'list':      return json({ ok: true, data: list_(req.from, req.to) });
      case 'create':    return json({ ok: true, data: create_(req.booking) });
      case 'cancel':    return json({ ok: true, data: cancel_(req.id, req.pin) });
      case 'ping':      return json({ ok: true, data: 'pong' });
      default:          return json({ ok: false, error: '알 수 없는 요청: ' + req.action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/** 브라우저로 웹앱 주소를 열었을 때 상태 확인용 */
function doGet() {
  return json({ ok: true, data: '회의실 예약 백엔드가 정상 동작 중입니다.' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ────────────────── 시트 준비 ────────────────── */

function book_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function bookingSheet_() {
  var ss = book_();
  var sh = ss.getSheetByName(SHEET_BOOKINGS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_BOOKINGS);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // 날짜가 Date 로 자동 변환되지 않도록 텍스트 서식 고정
    sh.getRange('C:C').setNumberFormat('@');
  }
  return sh;
}

function configSheet_() {
  var ss = book_();
  var sh = ss.getSheetByName(SHEET_CONFIG);
  if (!sh) {
    sh = ss.insertSheet(SHEET_CONFIG);
    sh.getRange(1, 1, 1, 2).setValues([['key', 'value']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ────────────────── 설정 ────────────────── */

function getConfig_() {
  var sh = configSheet_();
  var last = sh.getLastRow();
  if (last < 2) return null;
  var rows = sh.getRange(2, 1, last - 1, 2).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === 'main') {
      try { return JSON.parse(rows[i][1]); } catch (e) { return null; }
    }
  }
  return null;
}

function setConfig_(cfg, pinHash) {
  if (!cfg) throw new Error('설정 값이 없습니다.');
  var cur = getConfig_();
  // 관리자 비밀번호가 이미 있으면 반드시 일치해야 저장됩니다
  if (cur && cur.adminPinHash && cur.adminPinHash !== pinHash) {
    throw new Error('관리자 비밀번호가 맞지 않습니다.');
  }
  var sh = configSheet_();
  var last = sh.getLastRow();
  var value = JSON.stringify(cfg);
  for (var r = 2; r <= last; r++) {
    if (String(sh.getRange(r, 1).getValue()) === 'main') {
      sh.getRange(r, 2).setValue(value);
      return cfg;
    }
  }
  sh.appendRow(['main', value]);
  return cfg;
}

/* ────────────────── 예약 조회 ────────────────── */

function normDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, book_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  return String(v || '').trim();
}

function rowToBooking_(row) {
  return {
    id:        String(row[0]),
    roomId:    String(row[1]),
    date:      normDate_(row[2]),
    start:     Number(row[3]),
    end:       Number(row[4]),
    dept:      String(row[5] || ''),
    name:      String(row[6] || ''),
    title:     String(row[7] || ''),
    count:     row[8] === '' || row[8] == null ? null : Number(row[8]),
    memo:      String(row[9] || ''),
    pinHash:   '',                       // 비밀번호 해시는 브라우저로 내보내지 않습니다
    createdAt: String(row[11] || '')
  };
}

function allRows_() {
  var sh = bookingSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
}

function list_(from, to) {
  from = String(from || '0000-00-00');
  to   = String(to   || '9999-99-99');
  var out = [];
  var rows = allRows_();
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    var d = normDate_(rows[i][2]);
    if (d >= from && d <= to) out.push(rowToBooking_(rows[i]));
  }
  out.sort(function (a, b) {
    return a.date === b.date ? a.start - b.start : (a.date < b.date ? -1 : 1);
  });
  return out;
}

/* ────────────────── 예약 생성 ────────────────── */

function create_(b) {
  if (!b || !b.id || !b.roomId || !b.date) throw new Error('예약 정보가 올바르지 않습니다.');
  var start = Number(b.start), end = Number(b.end);
  if (!(end > start)) throw new Error('시간이 올바르지 않습니다.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.');
  try {
    // 잠금 안에서 다시 한 번 겹침 검사 — 동시 예약 방지의 핵심
    var rows = allRows_();
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i][0]) continue;
      if (String(rows[i][1]) !== String(b.roomId)) continue;
      if (normDate_(rows[i][2]) !== String(b.date)) continue;
      var s = Number(rows[i][3]), e2 = Number(rows[i][4]);
      if (s < end && start < e2) throw new Error('CONFLICT');
    }
    bookingSheet_().appendRow([
      b.id, b.roomId, b.date, start, end,
      b.dept || '', b.name || '', b.title || '',
      b.count == null ? '' : b.count, b.memo || '',
      b.pinHash || '', b.createdAt || new Date().toISOString()
    ]);
  } finally {
    lock.releaseLock();
  }
  return { id: b.id };
}

/* ────────────────── 예약 취소 ────────────────── */

function cancel_(id, pinHash) {
  if (!id) throw new Error('예약 번호가 없습니다.');
  var cfg = getConfig_();
  var adminHash = cfg && cfg.adminPinHash;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.');
  try {
    var sh = bookingSheet_();
    var last = sh.getLastRow();
    if (last < 2) throw new Error('예약을 찾을 수 없습니다.');
    var rows = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) !== String(id)) continue;
      var stored = String(rows[i][10] || '');
      var isOwner = stored && stored === pinHash;
      var isAdmin = adminHash && adminHash === pinHash;
      if (!isOwner && !isAdmin) throw new Error('BADPIN');
      sh.deleteRow(i + 2);
      return true;
    }
    throw new Error('예약을 찾을 수 없습니다.');
  } finally {
    lock.releaseLock();
  }
}

/* ────────────────── 관리용 (선택) ────────────────── */

/** 스프레드시트 메뉴에서 지난 예약을 정리하고 싶을 때 직접 실행하세요. */
function 지난예약_정리() {
  var keepFrom = Utilities.formatDate(
    new Date(Date.now() - 1000 * 60 * 60 * 24 * 180),
    book_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');   // 180일 이전 삭제
  var sh = bookingSheet_();
  var last = sh.getLastRow();
  if (last < 2) return;
  var rows = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] && normDate_(rows[i][2]) < keepFrom) sh.deleteRow(i + 2);
  }
}
