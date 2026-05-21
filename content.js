// content.js — WeRead PDF Exporter
(function () {
  'use strict';

  // ─── 全局状态 ──────────────────────────────────────────────────────────────
  let state = 'idle';
  let collectedBlocks = [];
  let seenTexts = new Set();
  let capturedPageCount = 0;
  let totalPagesEstimate = 0;
  let bookTitleText = '';
  let stopRequested = false;
  let activeTabId = null; // 用于消息 tabId 过滤

  // ─── 选择器 ────────────────────────────────────────────────────────────────
  const CONTAINER_SELECTORS = [
    '.readerChapterContent',
    '.reader_main',
    '.wr_readerSlide',
    '.renderTarget',
    '[class*="readerContent"]',
    '[class*="readerChapter"]',
  ];

  const NEXT_BTN_SELECTORS = [
    '.renderTarget_pager_button_right',
    '.readerFooter_right',
    '.reader_footer_right',
    '[class*="readerFooter"][class*="right"]',
    '[data-type="right"]',
  ];

  const INITIAL_CAPTURE_DELAY_MS = 1600;
  const PAGE_TURN_DELAY_MS = 2500;
  const RENDER_STABLE_DELAY_MS = 1600;
  const PAGE_CHANGE_TIMEOUT_MS = 9000;

  // ─── 工具 ──────────────────────────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getBookTitle() {
    for (const sel of ['.readerTopBar_title', '.bookInfo_title', '[class*="bookTitle"]']) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim())
        return el.textContent.trim().replace(/\s*[-—–|]\s*微信读书.*/i, '').trim();
    }
    return document.title.replace(/\s*[-—–|]\s*微信读书.*/i, '').trim() || '未知书籍';
  }

  function findContainer() {
    for (const sel of CONTAINER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && (el.textContent.trim().length > 10 || el.querySelector('canvas,img'))) return el;
    }
    return null;
  }

  function findNextButton() {
    for (const sel of NEXT_BTN_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 10
      && rect.height > 10
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0;
  }

  function getVisibleCanvases() {
    return Array.from(document.querySelectorAll('.renderTargetContainer canvas, canvas'))
      .filter(canvas => {
        const rect = canvas.getBoundingClientRect();
        return isVisible(canvas) && rect.width > 100 && rect.height > 100;
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return Math.abs(ar.top - br.top) > 5 ? ar.top - br.top : ar.left - br.left;
      });
  }

  function isInViewport(rect) {
    return rect.right > 0
      && rect.bottom > 0
      && rect.left < window.innerWidth
      && rect.top < window.innerHeight;
  }

  function getVisibleReaderImages() {
    return Array.from(document.querySelectorAll([
      '.readerChapterContent img',
      '.reader_main img',
      '.wr_readerSlide img',
      '.renderTargetContainer img',
      '[class*="readerContent"] img',
      '[class*="readerChapter"] img',
    ].join(',')))
      .filter(img => {
        const rect = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
        return src
          && !src.startsWith('chrome-extension://')
          && !src.startsWith('data:image/gif')
          && isVisible(img)
          && isInViewport(rect)
          && rect.width > 80
          && rect.height > 80;
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return Math.abs(ar.top - br.top) > 5 ? ar.top - br.top : ar.left - br.left;
      });
  }

  function rectContains(outer, inner) {
    return outer.left <= inner.left + 2
      && outer.top <= inner.top + 2
      && outer.right >= inner.right - 2
      && outer.bottom >= inner.bottom - 2;
  }

  function getVisibleCaptureTargets() {
    const targets = [...getVisibleCanvases(), ...getVisibleReaderImages()];
    const sorted = targets.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return Math.abs(ar.top - br.top) > 5 ? ar.top - br.top : ar.left - br.left;
    });
    const kept = [];
    for (const target of sorted) {
      const rect = target.getBoundingClientRect();
      const contained = kept.some(existing => rectContains(existing.getBoundingClientRect(), rect));
      if (!contained) kept.push(target);
    }
    return kept;
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(36);
  }

  function isDisabledLike(btn) {
    if (!btn) return false;
    const className = String(btn.className || '').toLowerCase();
    const style = getComputedStyle(btn);
    return btn.disabled
      || btn.getAttribute('aria-disabled') === 'true'
      || btn.getAttribute('disabled') !== null
      || className.includes('disabled')
      || className.includes('disable')
      || style.pointerEvents === 'none'
      || Number(style.opacity) < 0.2;
  }

  function isAtLastPage() {
    const btn = findNextButton();
    if (!btn) return false;
    return isDisabledLike(btn);
  }

  function parseRgb(color) {
    const m = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
    if (!m) return null;
    const alpha = m[4] == null ? 1 : Number(m[4]);
    if (alpha === 0) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), alpha };
  }

  function rgbToHex(rgb) {
    const part = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + part(rgb.r) + part(rgb.g) + part(rgb.b);
  }

  function effectiveBackgroundColor(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      const rgb = parseRgb(getComputedStyle(node).backgroundColor);
      if (rgb) {
        const isAlmostBlack = rgb.r < 16 && rgb.g < 16 && rgb.b < 16;
        return isAlmostBlack ? '#ffffff' : rgbToHex(rgb);
      }
      node = node.parentElement;
    }
    return '#ffffff';
  }

  function canvasToReadableJpeg(canvas) {
    // Cap width at 1200px to keep per-page size manageable (~50-80KB/page)
    const MAX_W = 1200;
    const scale = Math.min(1, MAX_W / canvas.width);
    const w = Math.round(canvas.width * scale);
    const h = Math.round(canvas.height * scale);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = effectiveBackgroundColor(canvas);
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0, w, h);
    return out.toDataURL('image/jpeg', 0.82);
  }

  function pageFingerprint(container) {
    const canvases = getVisibleCanvases();
    if (canvases.length) {
      return canvases.map(canvas => {
        try {
          return hashString(canvas.toDataURL('image/jpeg', 0.25));
        } catch {
          const rect = canvas.getBoundingClientRect();
          return [canvas.width, canvas.height, Math.round(rect.left), Math.round(rect.top)].join(':');
        }
      }).join('|');
    }
    const images = getVisibleReaderImages();
    if (images.length) {
      return images.map(img => {
        const rect = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
        return [
          src,
          img.naturalWidth || 0,
          img.naturalHeight || 0,
          Math.round(rect.left),
          Math.round(rect.top),
          Math.round(rect.width),
          Math.round(rect.height),
        ].join(':');
      }).join('|');
    }
    if (!container) return '__null__' + Date.now();
    return container.innerText.replace(/\s/g, '');
  }

  // ─── 图片转 base64 ─────────────────────────────────────────────────────────
  // fetch 委托给 background service worker（有完整 host_permissions，不受 CORS 限制）。
  async function imgToBase64(url) {
    if (!url || url.startsWith('chrome-extension://')) return null;
    if (url.startsWith('data:')) return url;
    try {
      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url }, r => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(r);
        });
      });
      return (resp && resp.ok) ? resp.dataUrl : null;
    } catch { return null; }
  }

  function captureVisibleTab() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' }, resp => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp || !resp.ok) {
          reject(new Error(resp && resp.error ? resp.error : '截图失败'));
          return;
        }
        resolve(resp.dataUrl);
      });
    });
  }

  function getReaderControlsForCapture() {
    const selectors = [
      '.renderTarget_pager_button',
      '.readerFooter_left',
      '.readerFooter_right',
      '.reader_footer_left',
      '.reader_footer_right',
      '[class*="readerFooter"][class*="left"]',
      '[class*="readerFooter"][class*="right"]',
      '[data-type="left"]',
      '[data-type="right"]',
    ];
    const controls = new Set(document.querySelectorAll(selectors.join(',')));
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const text = (el.textContent || '').replace(/\s+/g, '');
      if (text === '上一页' || text === '下一页') controls.add(el);
    }
    return Array.from(controls).filter(isVisible);
  }

  async function captureVisibleTabWithoutReaderControls() {
    const controls = getReaderControlsForCapture();
    const previous = controls.map(el => ({
      el,
      visibility: el.style.visibility,
      opacity: el.style.opacity,
    }));
    for (const { el } of previous) {
      el.style.visibility = 'hidden';
      el.style.opacity = '0';
    }

    // Let the compositor apply hidden controls before taking the tab screenshot.
    await sleep(80);
    try {
      return await captureVisibleTab();
    } finally {
      for (const item of previous) {
        item.el.style.visibility = item.visibility;
        item.el.style.opacity = item.opacity;
      }
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = src;
    });
  }

  async function cropCaptureBlocks(canvases) {
    const screenshot = await captureVisibleTabWithoutReaderControls();
    const shot = await loadImage(screenshot);
    const scaleX = shot.naturalWidth / window.innerWidth;
    const scaleY = shot.naturalHeight / window.innerHeight;
    const MAX_W = 1200;
    const blocks = [];

    for (const canvas of canvases) {
      const rect = canvas.getBoundingClientRect();
      const sx = Math.max(0, Math.round(rect.left * scaleX));
      const sy = Math.max(0, Math.round(rect.top * scaleY));
      const sw = Math.min(shot.naturalWidth - sx, Math.round(rect.width * scaleX));
      const sh = Math.min(shot.naturalHeight - sy, Math.round(rect.height * scaleY));
      if (sw <= 0 || sh <= 0) continue;

      const dstScale = Math.min(1, MAX_W / sw);
      const dw = Math.round(sw * dstScale);
      const dh = Math.round(sh * dstScale);
      const out = document.createElement('canvas');
      out.width = dw;
      out.height = dh;
      out.getContext('2d').drawImage(shot, sx, sy, sw, sh, 0, 0, dw, dh);
      const b64 = out.toDataURL('image/jpeg', 0.82);
      blocks.push({
        type: 'page',
        src: 'capture:' + hashString(b64),
        b64,
        width: dw,
        height: dh,
      });
    }

    return blocks;
  }

  // ─── 内容提取 ──────────────────────────────────────────────────────────────
  async function extractBlocks(container) {
    if (!container) return [];

    const captureTargets = getVisibleCaptureTargets();
    if (captureTargets.length) {
      const capturedBlocks = await cropCaptureBlocks(captureTargets);
      chrome.runtime.sendMessage({
        type: 'PROGRESS_DEBUG',
        msg: 'screen capture targets=' + captureTargets.length + ' blocks=' + capturedBlocks.length,
        tabId: activeTabId,
      }).catch(() => {});
      if (capturedBlocks.length) return capturedBlocks;
    }

    const canvases = getVisibleCanvases();
    if (canvases.length) {
      const pageBlocks = [];
      for (const canvas of canvases) {
        try {
          const b64 = canvasToReadableJpeg(canvas);
          // Sanity check: b64 must be a real image, not an empty/tiny data URL
          if (!b64 || b64.length < 1000) {
            chrome.runtime.sendMessage({ type: 'PROGRESS_DEBUG', msg: 'canvas b64 too short: ' + (b64 ? b64.length : 0), tabId: activeTabId }).catch(() => {});
            continue;
          }
          pageBlocks.push({
            type: 'page',
            src: 'canvas:' + hashString(b64),
            b64,
            width: canvas.width,
            height: canvas.height,
          });
        } catch (e) {
          chrome.runtime.sendMessage({ type: 'PROGRESS_DEBUG', msg: 'canvas tainted: ' + e.message, tabId: activeTabId }).catch(() => {});
        }
      }
      if (pageBlocks.length) return pageBlocks;
    }

    const blocks = [];
    const targets = container.querySelectorAll('h1,h2,h3,h4,p,img');

    for (const el of targets) {
      const tag = el.tagName.toLowerCase();
      if (!isVisible(el)) continue;

      if (tag === 'img') {
        const src = el.src || el.getAttribute('data-src') || el.getAttribute('data-original') || '';
        if (!src || src.startsWith('chrome-extension://') || src.startsWith('data:image/gif')) continue;
        const b64 = await imgToBase64(src);
        if (b64) blocks.push({ type: 'img', src, b64 });
        continue;
      }

      const text = el.innerText.replace(/\s+/g, ' ').trim();
      if (!text) continue;

      // 跳过嵌套在其他 p/h* 内的元素，避免重复
      const parentTag = el.parentElement ? el.parentElement.tagName.toLowerCase() : '';
      if (['h1', 'h2', 'h3', 'h4', 'p'].includes(parentTag)) continue;

      blocks.push({ type: tag, text });
    }
    return blocks;
  }

  // 返回真正新增的块数（去重后）
  function mergeBlocks(newBlocks) {
    let added = 0;
    for (const b of newBlocks) {
      const key = (b.type === 'img' || b.type === 'page') ? '__img__' + b.src : b.text;
      if (!seenTexts.has(key)) {
        seenTexts.add(key);
        collectedBlocks.push(b);
        added++;
      }
    }
    return added;
  }

  // ─── 翻页 ──────────────────────────────────────────────────────────────────
  function advancePage() {
    const btn = findNextButton();
    if (btn && !isAtLastPage()) {
      btn.click();
      return true;
    }
    if (btn && isAtLastPage()) return false;
    for (const evType of ['keydown', 'keyup']) {
      document.dispatchEvent(new KeyboardEvent(evType, {
        key: 'ArrowRight', code: 'ArrowRight',
        keyCode: 39, which: 39,
        bubbles: true, cancelable: true,
      }));
    }
    return true;
  }

  // 修复：监听 document.body，而非可能被整体替换的 container 节点
  function waitForChange(container, oldFp, timeout = 5000) {
    return new Promise(resolve => {
      const deadline = Date.now() + timeout;
      let resolved = false;

      function done(result) {
        if (resolved) return;
        resolved = true;
        obs.disconnect();
        clearInterval(timer);
        resolve(result);
      }

      // 监听 body：即使 container 节点被整体换掉也能感知
      const obs = new MutationObserver(() => {
        const c = findContainer();
        if (pageFingerprint(c) !== oldFp) done('changed');
      });
      obs.observe(document.body, { childList: true, subtree: true });

      const timer = setInterval(() => {
        const c = findContainer();
        if (pageFingerprint(c) !== oldFp) { done('changed'); return; }
        if (Date.now() >= deadline) done('timeout');
      }, 100);
    });
  }

  function estimateTotal() {
    for (const sel of ['.readerFooter_page', '[class*="pageCount"]', '[class*="pageNum"]']) {
      const el = document.querySelector(sel);
      if (el) {
        const m = el.textContent.match(/(\d+)\s*[\/／]\s*(\d+)/);
        if (m) return parseInt(m[2]);
      }
    }
    return 0;
  }

  // ─── 主采集循环 ────────────────────────────────────────────────────────────
  async function runExport() {
    state = 'capturing';
    collectedBlocks = [];
    seenTexts = new Set();
    capturedPageCount = 0;
    stopRequested = false;
    bookTitleText = getBookTitle();

    // stuckStreak：连续多少次翻页后页面指纹完全没变（真正卡住）才退出
    // 与"内容是否有新增"无关——内容重叠是正常现象，不应触发退出
    let stuckStreak = 0;
    const MAX_STUCK = 2;

    await sleep(INITIAL_CAPTURE_DELAY_MS);

    while (!stopRequested) {
      const container = findContainer();
      if (!container) { await sleep(500); continue; }

      // 采集当前页
      const fpBefore = pageFingerprint(container);
      const blocks = await extractBlocks(container);
      mergeBlocks(blocks); // 去重合并，added 值不再用于退出判断
      capturedPageCount++;

      const total = estimateTotal();
      if (total > 0) totalPagesEstimate = total;

      chrome.runtime.sendMessage({
        type: 'PROGRESS',
        pages: capturedPageCount,
        totalPages: totalPagesEstimate,
        title: bookTitleText,
        tabId: activeTabId,
      }).catch(() => {});

      // 退出条件1：下一页按钮明确 disabled
      if (isAtLastPage()) break;

      // 翻页
      const didAdvance = advancePage();
      if (!didAdvance) break;
      await sleep(PAGE_TURN_DELAY_MS);

      // 等待页面内容变化
      const changed = await waitForChange(container, fpBefore, PAGE_CHANGE_TIMEOUT_MS);

      if (changed === 'timeout') {
        // 超时后再等一次，确认真的卡住了
        await sleep(1000);
        const fpNow = pageFingerprint(findContainer());
        if (fpNow === fpBefore) {
          stuckStreak++;
          // 退出条件2：连续 N 次翻页后内容完全没变（真正到底或卡死）
          if (stuckStreak >= MAX_STUCK) break;
          continue; // 跳过本轮的 sleep(400)，直接进下一次翻页
        }
        // 内容其实变了（只是变化晚于 timeout），重置卡住计数
        stuckStreak = 0;
      } else {
        stuckStreak = 0;
        // 变化后等渲染稳定
        await sleep(RENDER_STABLE_DELAY_MS);
      }
    }

    state = 'done';
    let autoOpenedGenerator = false;
    if (!stopRequested && collectedBlocks.length > 0) {
      try {
        await saveDataForGenerator();
        chrome.runtime.sendMessage({ type: 'OPEN_GENERATOR' }).catch(() => {});
        autoOpenedGenerator = true;
      } catch (err) {
        chrome.runtime.sendMessage({
          type: 'EXPORT_ERROR', error: err.message, tabId: activeTabId,
        }).catch(() => {});
      }
    }
    chrome.runtime.sendMessage({
      type: stopRequested ? 'EXPORT_STOPPED' : 'EXPORT_DONE',
      pages: capturedPageCount,
      title: bookTitleText,
      autoOpenedGenerator,
      tabId: activeTabId,
    }).catch(() => {});
  }

  // ─── 存储数据 ──────────────────────────────────────────────────────────────
  // chrome.storage.local has an 8MB per-item limit even with unlimitedStorage.
  // We split blocks into chunks of ~4MB each to stay safe.
  function storageSet(items) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(items, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  function storageRemoveKeys(keys) {
    return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
  }

  async function saveToStorage(data) {
    const CHUNK_BYTES = 4 * 1024 * 1024; // 4MB per storage key
    const { blocks, ...meta } = data;

    // Build chunk array
    const chunks = [];
    let cur = [], curSize = 0;
    for (const b of blocks) {
      const s = JSON.stringify(b).length;
      if (curSize + s > CHUNK_BYTES && cur.length) {
        chunks.push(cur);
        cur = []; curSize = 0;
      }
      cur.push(b);
      curSize += s;
    }
    if (cur.length) chunks.push(cur);

    // Clean up old chunks
    const oldKeys = ['currentExport'];
    for (let i = 0; i < 100; i++) oldKeys.push('currentExportChunk_' + i);
    await storageRemoveKeys(oldKeys);

    // Write meta (no blocks)
    await storageSet({ currentExport: { ...meta, chunkCount: chunks.length } });

    // Write each chunk
    for (let i = 0; i < chunks.length; i++) {
      await storageSet({ ['currentExportChunk_' + i]: chunks[i] });
    }
  }

  async function saveDataForGenerator() {
    const data = {
      id: 'current',
      title: bookTitleText,
      blocks: collectedBlocks,
      savedAt: Date.now(),
    };
    const jsonStr = JSON.stringify(data);
    const sizeMB = (jsonStr.length / 1024 / 1024).toFixed(2);
    chrome.runtime.sendMessage({
      type: 'PROGRESS_DEBUG',
      msg: 'saving ' + collectedBlocks.length + ' blocks, size=' + sizeMB + 'MB, types=' + JSON.stringify([...new Set(collectedBlocks.map(b => b.type))]),
      tabId: activeTabId,
    }).catch(() => {});
    return saveToStorage(data);
  }

  // ─── 消息处理 ──────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 记录当前 tab id 用于多 tab 过滤
    if (sender.tab) activeTabId = sender.tab.id;

    if (msg.type === 'GET_STATE') {
      sendResponse({
        state,
        pages: capturedPageCount,
        totalPages: totalPagesEstimate,
        title: bookTitleText || getBookTitle(),
        tabId: activeTabId,
      });
      return true;
    }
    if (msg.type === 'START_EXPORT') {
      if (state === 'capturing') { sendResponse({ ok: false }); return true; }
      sendResponse({ ok: true });
      runExport().catch(err => {
        state = 'idle';
        chrome.runtime.sendMessage({
          type: 'EXPORT_ERROR', error: err.message, tabId: activeTabId,
        }).catch(() => {});
      });
      return true;
    }
    if (msg.type === 'STOP_EXPORT') {
      stopRequested = true;
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'GENERATE_PDF') {
      saveDataForGenerator()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  });

  if (location.hash.includes('wereadExporterSmokeTest=1')) {
    setTimeout(async () => {
      try {
        bookTitleText = '局外人-2.2-smoke';
        const blocks = await Promise.race([
          extractBlocks(findContainer()),
          new Promise((_, reject) => setTimeout(() => reject(new Error('smoke test timeout')), 15000)),
        ]);
        collectedBlocks = blocks;
        seenTexts = new Set(blocks.map(b => (b.type === 'img' || b.type === 'page') ? '__img__' + b.src : b.text));
        document.title = 'smoke blocks=' + blocks.length;
        await saveDataForGenerator();
        chrome.runtime.sendMessage({ type: 'OPEN_GENERATOR' }).catch(() => {});
      } catch (err) {
        document.title = 'smoke error: ' + err.message;
        chrome.runtime.sendMessage({ type: 'EXPORT_ERROR', error: err.message }).catch(() => {});
      }
    }, 2000);
  }

})();
