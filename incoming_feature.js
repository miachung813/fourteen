// ============================================================
// 收樣紀錄分頁：從收樣紀錄總表 (incomingsample.pages.dev) 撈取資料，
// 智慧比對「廠商名稱」與報價系統「客戶名稱」，並依「取樣測項」比對該客戶
// 報價單裡對應那一項檢驗的單價（不是整張報價單的總價，才能拿來拉當月業
// 績）。比對不到的可以手動輸入金額，會雲端同步保存。
// ============================================================
const INCOMING_BASE = 'https://incomingsample.pages.dev/';
const INCOMING_PAGE_SIZE = 100;

let incomingManifest = null;      // manifest.json 內容
let incomingRows = [];            // 已載入的收樣資料（含比對結果）
let incomingLoadedYms = [];       // 目前載入的月份
let incomingPage = 1;
let incomingLoading = false;
const incomingMonthCache = {};    // ym -> rows

// 手動輸入的金額覆蓋層：reportNo -> { amount, vendor, customer, updatedAt }
// 雲端同步（跟客戶/檢驗項目/報價記錄/常用備註一樣，整批覆蓋對應試算表分頁）。
let incomingAmountOverrides = {};

// ---------- 名稱正規化與智慧比對 ----------
function inNorm(s) {
  s = String(s == null ? '' : s).trim();
  // 全形轉半形
  s = s.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
  s = s.toLowerCase();
  s = s.replace(/[\s ]/g, '');
  s = s.replace(/[()\[\]{}．.·、,，'"“”‘’\-—_/\\]/g, '');
  return s;
}
const IN_SUFFIXES = ['股份有限公司', '企業有限公司', '實業有限公司', '食品有限公司', '有限公司', '企業社', '企業行', '實業社', '商行', '工作室', '農產行', '食品行', '水產行', '公司'];
function inCoreName(s) {
  let t = inNorm(s);
  for (const suf of IN_SUFFIXES) {
    if (t.endsWith(suf) && t.length > suf.length + 1) { t = t.slice(0, -suf.length); break; }
  }
  return t;
}

// 建立客戶比對索引（每次載入資料時重建，確保吃到最新客戶資料庫）
function buildIncomingCustIndex() {
  const exact = new Map();   // 完整正規化名稱 -> cust
  const core = new Map();    // 去掉公司字尾 -> cust
  const coreList = [];       // 供「包含」比對用
  const custs = (typeof allCustomers === 'function') ? allCustomers() : (typeof CUSTOMERS !== 'undefined' ? CUSTOMERS : []);
  for (const c of custs) {
    for (const nm of [c.name, c.short]) {
      if (!nm) continue;
      const n = inNorm(nm), k = inCoreName(nm);
      if (n && !exact.has(n)) exact.set(n, c);
      if (k && !core.has(k)) { core.set(k, c); coreList.push([k, c]); }
    }
  }
  return { exact, core, coreList };
}

// 廠商名稱 -> {cust, level}；level: 'exact' 完全符合 / 'fuzzy' 相似（包含關係）
function matchVendorToCustomer(vendor, idx, memo) {
  if (memo.has(vendor)) return memo.get(vendor);
  let result = null;
  const n = inNorm(vendor);
  if (n) {
    if (idx.exact.has(n)) result = { cust: idx.exact.get(n), level: 'exact' };
    else {
      const k = inCoreName(vendor);
      if (idx.core.has(k)) result = { cust: idx.core.get(k), level: 'exact' };
      else if (k.length >= 4) {
        for (const [ck, c] of idx.coreList) {
          if (ck.length >= 4 && (ck.includes(k) || k.includes(ck))) { result = { cust: c, level: 'fuzzy' }; break; }
        }
      }
    }
  }
  memo.set(vendor, result);
  return result;
}

// ---------- 報價單「每項檢驗單價」比對 ----------
// 報價單項目的 sample 欄位其實是「最少樣品量」（例如「100g」），不是樣品
// 名稱，不能拿來比對；真正該比對的是收樣紀錄的「取樣測項」對上報價單項目
// 的「品名」（item 欄位，例如「重金屬」「農藥411項」），抓到的才是那一項
// 檢驗真正的單價。同一個客戶名下可能有很多張報價單，全部一起搜尋，抓分數
// 最高、其次最新的那一項。
function buildQuoteIndexByCust() {
  const map = new Map();
  const list = (typeof quoteHistory !== 'undefined' && Array.isArray(quoteHistory)) ? quoteHistory : [];
  for (const q of list) {
    const k = inCoreName(q.company);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(q);
  }
  for (const arr of map.values()) arr.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return map;
}
function findBestItemForRow(row, cust, quoteIdx) {
  const arr = quoteIdx.get(inCoreName(cust.name)) || quoteIdx.get(inCoreName(cust.short || '')) || [];
  if (!arr.length) return null;
  const testN = inNorm(row.test_item);
  if (!testN) return null;
  let best = null, bestScore = 0;
  // arr 已按日期新到舊排序；分數相同時越新的報價單優先（先遍歷到就不會被
  // 後面分數相同但較舊的覆蓋，因為只在 score 嚴格更高時才替換）。
  for (const q of arr) {
    const items = Array.isArray(q.items) ? q.items : [];
    for (const it of items) {
      const b = inNorm(it.item);
      if (!b) continue;
      let score = 0;
      if (b === testN) score = 3;               // 完全符合
      else if (b.includes(testN) || testN.includes(b)) score = 2; // 相似（包含關係）
      if (score > bestScore) { bestScore = score; best = { q, it, score }; }
    }
  }
  return best; // null 代表這個客戶名下找不到任何比對得到的檢驗項目
}

// 算出某一筆收樣紀錄「目前應該顯示的金額」：手動輸入過的優先，否則用自動
// 比對到的單價，都沒有就是 none（畫面上會是空的可編輯輸入框）。
function getRowPriceInfo(x) {
  const ov = incomingAmountOverrides[x.r.report_no];
  if (ov && ov.amount != null && ov.amount !== '') {
    return { amount: Number(ov.amount), source: 'manual' };
  }
  if (x.itemMatch) {
    return {
      amount: Number(x.itemMatch.it.price) || 0,
      source: x.itemMatch.score >= 3 ? 'auto' : 'auto-fuzzy',
      quoteNo: x.itemMatch.q.quoteNo, date: x.itemMatch.q.date, itemName: x.itemMatch.it.item,
    };
  }
  return { amount: null, source: 'none' };
}

// ---------- 資料載入 ----------
async function inFetchJson(path) {
  const url = INCOMING_BASE + path;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.ok) return await r.json();
    throw new Error('HTTP ' + r.status);
  } catch (e) {
    // 若站台有登入保護，改帶認證 cookie 再試一次
    const r2 = await fetch(url, { cache: 'no-store', credentials: 'include' });
    if (!r2.ok) throw new Error('HTTP ' + r2.status);
    return await r2.json();
  }
}

function inYmOptions() {
  const months = (incomingManifest && incomingManifest.months) ? incomingManifest.months.map(m => m.ym) : [];
  return months.slice().sort();
}

async function loadIncomingData(force) {
  if (incomingLoading) return;
  incomingLoading = true;
  const meta = document.getElementById('incomingMeta');
  const errBox = document.getElementById('incomingError');
  errBox.style.display = 'none';
  try {
    meta.textContent = '載入中...';
    if (!incomingManifest || force) {
      incomingManifest = await inFetchJson('manifest.json');
      const yms = inYmOptions();
      const selFrom = document.getElementById('inFromYm');
      const selTo = document.getElementById('inToYm');
      const prevFrom = selFrom.value, prevTo = selTo.value;
      selFrom.innerHTML = yms.map(y => '<option value="' + y + '">' + y + '</option>').join('');
      selTo.innerHTML = selFrom.innerHTML;
      // 預設載入最近 4 個月（目前即 4～7 月）
      const defFrom = yms[Math.max(0, yms.length - 4)] || yms[0];
      selFrom.value = (prevFrom && yms.includes(prevFrom)) ? prevFrom : defFrom;
      selTo.value = (prevTo && yms.includes(prevTo)) ? prevTo : yms[yms.length - 1];
    }
    const yms = inYmOptions();
    let from = document.getElementById('inFromYm').value, to = document.getElementById('inToYm').value;
    if (from > to) { const t = from; from = to; to = t; }
    const wanted = yms.filter(y => y >= from && y <= to);
    const monthObjs = incomingManifest.months.filter(m => wanted.includes(m.ym));
    const loaded = await Promise.all(monthObjs.map(async m => {
      if (!force && incomingMonthCache[m.ym]) return incomingMonthCache[m.ym];
      const rows = await inFetchJson(m.file);
      incomingMonthCache[m.ym] = Array.isArray(rows) ? rows : (rows.rows || []);
      return incomingMonthCache[m.ym];
    }));
    incomingLoadedYms = wanted;

    // 比對
    const idx = buildIncomingCustIndex();
    const quoteIdx = buildQuoteIndexByCust();
    const memo = new Map();
    const out = [];
    for (const rows of loaded) {
      for (const r of rows) {
        const m = r.vendor ? matchVendorToCustomer(String(r.vendor), idx, memo) : null;
        let itemMatch = null;
        if (m) itemMatch = findBestItemForRow(r, m.cust, quoteIdx);
        out.push({ r, cust: m ? m.cust : null, level: m ? m.level : null, itemMatch });
      }
    }
    // 依進件日期新→舊
    out.sort((a, b) => String(b.r.in_date || '').localeCompare(String(a.r.in_date || '')));
    incomingRows = out;

    // 客戶下拉選單
    const counts = new Map();
    for (const x of incomingRows) if (x.cust) counts.set(x.cust.name, (counts.get(x.cust.name) || 0) + 1);
    const sel = document.getElementById('inCustFilter');
    const prev = sel.value;
    const opts = [...counts.entries()].sort((a, b) => b[1] - a[1])
      .map(([nm, c]) => '<option value="' + nm.replace(/"/g, '&quot;') + '">' + nm + '（' + c + '）</option>');
    sel.innerHTML = '<option value="">全部客戶</option>' + opts.join('');
    if ([...counts.keys()].includes(prev)) sel.value = prev;

    incomingQuoteCountAtLoad = (typeof quoteHistory !== 'undefined' && Array.isArray(quoteHistory)) ? quoteHistory.length : 0;
    incomingPage = 1;
    renderIncomingTable();
  } catch (e) {
    meta.textContent = '載入失敗';
    errBox.style.display = '';
    errBox.innerHTML = '無法讀取收樣紀錄總表資料（' + String(e.message || e) + '）。<br>' +
      '若是第一次使用：請先在收樣紀錄總表的網站專案加入 <b>_headers</b> 檔並重新部署（開放本網站跨網域讀取），完成後再按「重新載入」。';
  } finally {
    incomingLoading = false;
  }
}

// ---------- 畫面 ----------
function inEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function incomingFilteredRows() {
  const q = inNorm(document.getElementById('inSearch').value);
  const onlyMatched = document.getElementById('inOnlyMatched').checked;
  const custFilter = document.getElementById('inCustFilter').value;
  return incomingRows.filter(x => {
    if (onlyMatched && !x.cust) return false;
    if (custFilter && (!x.cust || x.cust.name !== custFilter)) return false;
    if (q) {
      const info = getRowPriceInfo(x);
      const hay = inNorm([x.r.report_no, x.r.vendor, x.r.sample, x.r.test_item, x.cust ? x.cust.name : '', info.quoteNo || ''].join('|'));
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// 收樣資料表格的金額欄位是可編輯輸入框，用事件代理（而不是每一列各自綁
// inline onclick／onchange）比較安全，也不用擔心報告號碼裡出現特殊字元
// 需要跳脫。這個函式只需要在分頁第一次渲染時掛一次。
let incomingAmountDelegated = false;
function setupIncomingAmountDelegation() {
  if (incomingAmountDelegated) return;
  const body = document.getElementById('incomingTableBody');
  if (!body) return;
  incomingAmountDelegated = true;
  body.addEventListener('change', (e) => {
    const el = e.target.closest('.incoming-amt-input');
    if (!el) return;
    onIncomingAmountChange(el.dataset.reportno, el.value);
  });
  body.addEventListener('click', (e) => {
    const el = e.target.closest('.incoming-amt-clear');
    if (el) { clearIncomingAmount(el.dataset.reportno); return; }
  });
}
function onIncomingAmountChange(reportNo, rawValue) {
  const v = String(rawValue == null ? '' : rawValue).trim();
  if (v === '') {
    delete incomingAmountOverrides[reportNo];
  } else {
    const num = parseFloat(v);
    if (isNaN(num)) { alert('請輸入數字'); renderIncomingTable(); return; }
    const x = incomingRows.find(x => x.r.report_no === reportNo);
    incomingAmountOverrides[reportNo] = {
      amount: num,
      vendor: x ? (x.r.vendor || '') : '',
      customer: x && x.cust ? x.cust.name : '',
      updatedAt: nowIso(),
    };
  }
  renderIncomingTable();
  syncIncomingAmountsToCloud();
}
function clearIncomingAmount(reportNo) {
  delete incomingAmountOverrides[reportNo];
  renderIncomingTable();
  syncIncomingAmountsToCloud();
}

function renderIncomingTable() {
  setupIncomingAmountDelegation();
  const body = document.getElementById('incomingTableBody');
  const meta = document.getElementById('incomingMeta');
  const list = incomingFilteredRows();
  const matchedAll = incomingRows.filter(x => x.cust);
  const custSet = new Set(matchedAll.map(x => x.cust.name));
  const priced = incomingRows.map(getRowPriceInfo).filter(p => p.amount != null);
  const pricedTotal = priced.reduce((s, p) => s + p.amount, 0);
  meta.textContent = '月份 ' + (incomingLoadedYms.join('、') || '—') + '：收樣共 ' + incomingRows.length +
    ' 筆；比對到報價客戶 ' + matchedAll.length + ' 筆（' + custSet.size + ' 個客戶）；' +
    '已有金額 ' + priced.length + ' 筆，合計 ' + (typeof fmt === 'function' ? fmt(pricedTotal) : ('$' + pricedTotal)) +
    '；目前顯示 ' + list.length + ' 筆';

  const totalPages = Math.max(1, Math.ceil(list.length / INCOMING_PAGE_SIZE));
  if (incomingPage > totalPages) incomingPage = totalPages;
  const pageItems = list.slice((incomingPage - 1) * INCOMING_PAGE_SIZE, incomingPage * INCOMING_PAGE_SIZE);

  body.innerHTML = pageItems.map(x => {
    const r = x.r;
    let custCell = '<span style="color:#999;">—</span>';
    if (x.cust) {
      const badge = x.level === 'exact'
        ? '<span style="background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:1px 6px;font-size:12px;margin-left:4px;">符合</span>'
        : '<span style="background:#fff3e0;color:#e65100;border-radius:4px;padding:1px 6px;font-size:12px;margin-left:4px;">相似</span>';
      custCell = inEsc(x.cust.name) + badge;
    }

    const info = getRowPriceInfo(x);
    let quoteNoCell = '<span style="color:#999;">—</span>';
    if (info.source === 'auto' || info.source === 'auto-fuzzy') {
      const badge = info.source === 'auto'
        ? '<span style="color:#2e7d32;">✓對應測項</span>'
        : '<span style="color:#e65100;">相似測項</span>';
      quoteNoCell = inEsc(info.quoteNo) + '<div style="font-size:12px;color:#888;">' + inEsc(info.date || '') + ' · ' + inEsc(info.itemName || '') + ' ' + badge + '</div>';
    } else if (info.source === 'manual') {
      quoteNoCell = '<span style="color:#999;">（手動輸入）</span>';
    }

    const reportNo = r.report_no || '';
    const inputVal = info.amount != null ? info.amount : '';
    let amtCell = '<input type="number" class="incoming-amt-input" data-reportno="' + inEsc(reportNo) + '" value="' + inEsc(inputVal) + '" placeholder="輸入金額" style="width:88px;">';
    if (info.source === 'manual') {
      amtCell += ' <span style="color:#1565c0;font-size:11px;">(手動)</span>' +
        '<button type="button" class="incoming-amt-clear" data-reportno="' + inEsc(reportNo) + '" title="清除手動金額，' +
        (x.itemMatch ? '恢復自動比對的金額' : '清空') + '" style="border:none;background:none;color:#999;cursor:pointer;">✕</button>';
    }

    return '<tr>' +
      '<td class="nowrap">' + inEsc(r.report_no) + '</td>' +
      '<td>' + inEsc(r.vendor) + '</td>' +
      '<td>' + custCell + '</td>' +
      '<td>' + inEsc(r.sample) + '</td>' +
      '<td>' + inEsc(r.test_item) + '</td>' +
      '<td class="nowrap">' + inEsc(r.in_date) + '</td>' +
      '<td class="nowrap">' + inEsc(r.due_date) + '</td>' +
      '<td class="nowrap">' + inEsc(r.report_date) + '</td>' +
      '<td class="nowrap">' + quoteNoCell + '</td>' +
      '<td class="nowrap">' + amtCell + '</td>' +
      '</tr>';
  }).join('');

  const pag = document.getElementById('incomingPagination');
  pag.innerHTML = totalPages <= 1 ? '' :
    '<button class="btn-ghost" ' + (incomingPage <= 1 ? 'disabled' : '') + ' onclick="incomingPage--; renderIncomingTable()">上一頁</button>' +
    '<span style="margin:0 10px;">第 ' + incomingPage + ' / ' + totalPages + ' 頁</span>' +
    '<button class="btn-ghost" ' + (incomingPage >= totalPages ? 'disabled' : '') + ' onclick="incomingPage++; renderIncomingTable()">下一頁</button>';
}

let incomingQuoteCountAtLoad = -1;
function renderIncomingPage() {
  const qc = (typeof quoteHistory !== 'undefined' && Array.isArray(quoteHistory)) ? quoteHistory.length : 0;
  if (!incomingLoading && (!incomingRows.length || qc !== incomingQuoteCountAtLoad)) loadIncomingData();
  else renderIncomingTable();
}

function exportIncomingMatched() {
  if (typeof XLSX === 'undefined') { alert('此頁面未載入 Excel 元件，無法匯出'); return; }
  const list = incomingFilteredRows();
  if (!list.length) { alert('目前沒有可匯出的資料'); return; }
  const rows = list.map(x => {
    const info = getRowPriceInfo(x);
    const sourceLabel = { auto: '自動比對', 'auto-fuzzy': '相似比對', manual: '手動輸入', none: '' }[info.source] || '';
    return {
      '報告號碼': x.r.report_no || '', '廠商名稱': x.r.vendor || '',
      '對應客戶': x.cust ? x.cust.name : '', '比對方式': x.cust ? (x.level === 'exact' ? '符合' : '相似') : '',
      '樣品名稱': x.r.sample || '', '取樣測項': x.r.test_item || '',
      '進件日期': x.r.in_date || '', '預定出件日期': x.r.due_date || '', '電子報告出件日': x.r.report_date || '',
      '報價單號': info.quoteNo || '', '比對到的檢驗項目': info.itemName || '',
      '報價金額': info.amount != null ? info.amount : '', '金額來源': sourceLabel,
    };
  });
  const totalAmt = rows.reduce((s, r) => s + (typeof r['報價金額'] === 'number' ? r['報價金額'] : 0), 0);
  rows.push({ '報告號碼': '合計', '報價金額': totalAmt });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '收樣比對');
  XLSX.writeFile(wb, '收樣紀錄比對_' + incomingLoadedYms.join('-') + '.xlsx');
}

// ---------- 手動金額：雲端同步（跟客戶/檢驗項目/報價記錄/常用備註同一套機制） ----------
function incomingAmountsToCloudRows() {
  return Object.keys(incomingAmountOverrides).map(reportNo => {
    const o = incomingAmountOverrides[reportNo] || {};
    return {
      reportNo: reportNo, vendor: o.vendor || '', customer: o.customer || '',
      amount: (o.amount != null ? o.amount : ''), updatedAt: o.updatedAt || nowIso(),
    };
  });
}
function applyCloudIncomingAmountRows(rows) {
  const map = {};
  (rows || []).forEach(r => {
    const reportNo = cloudStr(r.reportNo);
    if (!reportNo) return;
    const amt = (r.amount === '' || r.amount == null) ? null : parseFloat(r.amount);
    if (amt == null || isNaN(amt)) return;
    map[reportNo] = { amount: amt, vendor: cloudStr(r.vendor), customer: cloudStr(r.customer), updatedAt: cloudStr(r.updatedAt) };
  });
  incomingAmountOverrides = map;
}
async function syncIncomingAmountsToCloud() {
  if (!CLOUD_ENABLED) return;
  cloudSyncState = 'syncing'; updateCloudStatusUI();
  try {
    await cloudPost('incomingAmounts', incomingAmountsToCloudRows());
    cloudSyncState = 'ok';
  } catch (err) {
    cloudSyncState = 'error'; cloudLastError = String((err && err.message) || err);
  }
  updateCloudStatusUI();
}
