chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'OPEN_GENERATOR') {
    chrome.tabs.create({ url: chrome.runtime.getURL('generate.html') });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'FETCH_IMAGE') {
    fetch(msg.url, { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(blob => createImageBitmap(blob))
      .then(bitmap => {
        const MAX = 1200;
        const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      })
      .then(blob => new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result);
        reader.onerror = () => rej(new Error('FileReader failed'));
        reader.readAsDataURL(blob);
      }))
      .then(dataUrl => sendResponse({ ok: true, dataUrl }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'CAPTURE_VISIBLE_TAB') {
    const windowId = sender.tab && sender.tab.windowId;
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 92 }, dataUrl => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true, dataUrl });
    });
    return true;
  }
});

