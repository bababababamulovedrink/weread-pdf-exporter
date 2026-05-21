// popup.js
let capturing = false;
let capturedPages = 0;
let activeTabId = null; // 记录当前操作的 tab，过滤其他 tab 的消息

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const pdfBtn = document.getElementById('pdfBtn');
const statusMsg = document.getElementById('statusMsg');
const progressArea = document.getElementById('progressArea');
const progressText = document.getElementById('progressText');
const progressBar = document.getElementById('progressBar');
const bookTitle = document.getElementById('bookTitle');

function setStatus(msg, type = '') {
  statusMsg.textContent = msg;
  statusMsg.className = 'status-msg' + (type ? ' ' + type : '');
}

function setProgress(pages, total) {
  progressText.textContent = `${pages} 页`;
  progressBar.style.width = total > 0
    ? Math.min(100, (pages / total) * 100) + '%'
    : '55%';
}

async function getActiveTab() {
  return new Promise(resolve =>
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0]))
  );
}

async function sendToContent(msg) {
  const tab = await getActiveTab();
  activeTabId = tab.id;
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, msg, resp => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

async function init() {
  try {
    const tab = await getActiveTab();
    activeTabId = tab.id;
    const resp = await sendToContent({ type: 'GET_STATE' });
    if (!resp) return;
    // 同步 content script 里记录的 tabId
    if (resp.tabId) activeTabId = resp.tabId;
    bookTitle.textContent = resp.title || '未知书籍';
    if (resp.state === 'capturing') {
      onCapturingStarted();
      setProgress(resp.pages, resp.totalPages);
    } else if (resp.state === 'done') {
      onCaptureDone(resp.pages);
    }
  } catch {
    bookTitle.textContent = '无法连接（请在阅读页面使用）';
    setStatus('请打开微信读书并进入阅读页面后再使用。', 'error');
    startBtn.disabled = true;
  }
}

function onCapturingStarted() {
  capturing = true;
  startBtn.style.display = 'none';
  stopBtn.style.display = 'block';
  pdfBtn.disabled = true;
  progressArea.style.display = 'block';
  setStatus('正在自动翻页采集内容，请勿操作页面…');
}

function onCaptureDone(pages) {
  capturing = false;
  startBtn.style.display = 'block';
  startBtn.textContent = '重新导出';
  stopBtn.style.display = 'none';
  pdfBtn.disabled = false;
  setStatus(`采集完成，共 ${pages} 页。点击"生成 PDF"下载。`, 'success');
}

startBtn.addEventListener('click', async () => {
  try {
    pdfBtn.disabled = true;
    capturedPages = 0;
    progressBar.style.width = '0%';
    onCapturingStarted();
    await sendToContent({ type: 'START_EXPORT' });
  } catch (e) {
    setStatus('启动失败：' + e.message, 'error');
    startBtn.style.display = 'block';
    stopBtn.style.display = 'none';
    capturing = false;
  }
});

stopBtn.addEventListener('click', async () => {
  try { await sendToContent({ type: 'STOP_EXPORT' }); } catch {}
  capturing = false;
  startBtn.style.display = 'block';
  startBtn.textContent = '开始导出';
  stopBtn.style.display = 'none';
  setStatus('已停止。如已采集部分内容，可点击"生成 PDF"下载。');
});

pdfBtn.addEventListener('click', async () => {
  try {
    pdfBtn.disabled = true;
    setStatus('正在准备数据…');
    const resp = await sendToContent({ type: 'GENERATE_PDF' });
    if (!resp || !resp.ok) throw new Error(resp && resp.error ? resp.error : '数据保存失败');
    chrome.tabs.create({ url: chrome.runtime.getURL('generate.html') });
    setStatus('已打开 PDF 生成页面，请稍候自动下载…', 'success');
    pdfBtn.disabled = false;
  } catch (e) {
    pdfBtn.disabled = false;
    setStatus('生成失败：' + e.message, 'error');
  }
});

// 只处理来自当前操作 tab 的消息
chrome.runtime.onMessage.addListener((msg) => {
  if (activeTabId && msg.tabId && msg.tabId !== activeTabId) return;

  if (msg.type === 'PROGRESS') {
    bookTitle.textContent = msg.title || bookTitle.textContent;
    capturedPages = msg.pages;
    setProgress(msg.pages, msg.totalPages || 0);
    setStatus(`正在采集第 ${msg.pages} 页…`);
  } else if (msg.type === 'EXPORT_DONE') {
    onCaptureDone(msg.pages);
    if (msg.autoOpenedGenerator) {
      setStatus(`采集完成，共 ${msg.pages} 页。已自动开始生成 PDF。`, 'success');
    }
  } else if (msg.type === 'EXPORT_STOPPED') {
    capturing = false;
    startBtn.style.display = 'block';
    startBtn.textContent = '开始导出';
    stopBtn.style.display = 'none';
    setStatus(`已停止，已采集 ${msg.pages} 页。`);
    if (msg.pages > 0) pdfBtn.disabled = false;
  } else if (msg.type === 'PROGRESS_DEBUG') {
    console.log('[WeRead Debug]', msg.msg);
    setStatus('[Debug] ' + msg.msg);
  } else if (msg.type === 'EXPORT_ERROR') {
    capturing = false;
    startBtn.style.display = 'block';
    stopBtn.style.display = 'none';
    setStatus('采集错误：' + msg.error, 'error');
  }
});

init();
