(async function () {
  const barEl   = document.getElementById('bar');
  const logEl   = document.getElementById('log');
  const titleEl = document.getElementById('cardTitle');
  const iconEl  = document.getElementById('icon');
  const subEl   = document.getElementById('sub');
  const msgEl   = document.getElementById('msg');

  function setBar(p) { barEl.style.width = Math.min(100, p) + '%'; }
  function setLog(t) { logEl.textContent = t; }

  function showError(e) {
    iconEl.textContent = '❌';
    titleEl.textContent = '生成失败';
    subEl.textContent = '';
    const d = document.createElement('div');
    d.className = 'err';
    d.textContent = String(e);
    msgEl.appendChild(d);
    console.error(e);
  }

  function showDone(name) {
    iconEl.textContent = '✅';
    titleEl.textContent = 'PDF 已下载';
    subEl.textContent = '此页面可以关闭。';
    barEl.style.width = '100%';
    setLog('');
    const d = document.createElement('div');
    d.className = 'done-msg';
    d.textContent = '《' + name + '》已保存到下载文件夹';
    msgEl.appendChild(d);
  }

  // ── chrome.storage.local（chunked to avoid 8MB per-item limit）────────────
  function storageGetRaw(keys) {
    return new Promise((res, rej) => {
      chrome.storage.local.get(keys, result => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res(result);
      });
    });
  }

  async function storageGet() {
    const meta = (await storageGetRaw('currentExport')).currentExport;
    if (!meta) return null;
    if (!meta.chunkCount) {
      // Legacy single-item format
      return meta.blocks ? meta : null;
    }
    const chunkKeys = [];
    for (let i = 0; i < meta.chunkCount; i++) chunkKeys.push('currentExportChunk_' + i);
    const chunks = await storageGetRaw(chunkKeys);
    const blocks = [];
    for (const k of chunkKeys) {
      if (chunks[k]) blocks.push(...chunks[k]);
    }
    return { ...meta, blocks };
  }

  function storageClear() {
    return new Promise(res => {
      const keys = ['currentExport'];
      for (let i = 0; i < 100; i++) keys.push('currentExportChunk_' + i);
      chrome.storage.local.remove(keys, res);
    });
  }

  // ── 版式常量 ───────────────────────────────────────────────────────────────
  const PW = 210, PH = 297;
  const ML = 22, MR = 22;
  const MT = 28, MB = 22;
  const HEADER_H = 7, FOOTER_H = 7;
  const CW       = PW - ML - MR;
  const BODY_TOP = MT + HEADER_H;
  const BODY_H   = PH - BODY_TOP - MB - FOOTER_H;

  const RENDER_W  = 794;
  const SCALE     = 2;
  const PX_PER_MM = (RENDER_W * SCALE) / PW;
  const PAD_PX    = Math.round(ML * (RENDER_W / PW));

  const CHUNK_BLOCKS = 60;

  // ── 渲染舞台（直接 append 到 body，html2canvas 截元素本身）─────────────────
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-9999px;top:0;pointer-events:none;';
  document.body.appendChild(stage);

  // ── 构建内容 div ───────────────────────────────────────────────────────────
  function buildDiv(blocks, isFirst) {
    const w = document.createElement('div');
    // 关键：明确宽高，白色背景，不受页面其他样式影响
    w.style.cssText = [
      'width:'         + RENDER_W + 'px',
      'background:#ffffff',
      'padding-left:'  + PAD_PX + 'px',
      'padding-right:' + PAD_PX + 'px',
      'padding-top:'   + (isFirst ? '24' : '0') + 'px',
      'padding-bottom:0',
      'box-sizing:border-box',
      'font-family:"PingFang SC","Hiragino Sans GB","STSong","SimSun","Microsoft YaHei",serif',
      'font-size:16px',
      'line-height:1.95',
      'color:#1f1f2e',
      'word-break:break-word',
    ].join(';');

    let lastType = null;
    for (const block of blocks) {
      let el;
      if (block.type === 'img') {
        const src = block.b64 || block.src;
        if (!src) continue;
        el = document.createElement('figure');
        el.style.cssText = 'margin:28px 0;text-align:center;line-height:0;';
        const img = document.createElement('img');
        img.src = src;
        img.style.cssText = 'max-width:86%;height:auto;display:inline-block;border-radius:4px;';
        el.appendChild(img);

      } else if (block.type === 'h1') {
        el = document.createElement('h1');
        el.textContent = block.text;
        el.style.cssText = 'font-size:22px;font-weight:800;color:#1a1a2e;margin-top:' + (lastType ? '48px' : '0') + ';margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid #4f46e5;line-height:1.45;letter-spacing:0.02em;';

      } else if (block.type === 'h2') {
        el = document.createElement('h2');
        el.textContent = block.text;
        el.style.cssText = 'font-size:18px;font-weight:700;color:#1a1a2e;margin-top:' + (lastType ? '36px' : '0') + ';margin-bottom:8px;padding-left:12px;border-left:4px solid #4f46e5;line-height:1.45;';

      } else if (block.type === 'h3') {
        el = document.createElement('h3');
        el.textContent = block.text;
        el.style.cssText = 'font-size:15px;font-weight:700;color:#2d2d3e;margin-top:' + (lastType ? '24px' : '0') + ';margin-bottom:5px;padding-left:9px;border-left:3px solid #7c3aed;line-height:1.45;';

      } else if (block.type === 'h4') {
        el = document.createElement('h4');
        el.textContent = block.text;
        el.style.cssText = 'font-size:14px;font-weight:600;color:#3d3d4e;margin-top:18px;margin-bottom:3px;line-height:1.45;';

      } else {
        el = document.createElement('p');
        el.textContent = block.text;
        const afterH = lastType && ['h1','h2','h3','h4'].includes(lastType);
        el.style.cssText = 'margin:0;margin-top:' + (lastType === 'p' ? '0' : '2px') + ';text-indent:' + (afterH ? '0' : '2em') + ';text-align:justify;';
      }

      w.appendChild(el);
      lastType = block.type;
    }
    return w;
  }

  // ── 等待图片加载 ───────────────────────────────────────────────────────────
  function waitImgs(el) {
    return Promise.all(Array.from(el.querySelectorAll('img')).map(img =>
      img.complete ? Promise.resolve()
        : new Promise(r => { img.onload = r; img.onerror = r; })
    ));
  }

  // ── 渲染 div → canvas（带超时）────────────────────────────────────────────
  function renderOne(div) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('html2canvas 超时')), 60000);
      html2canvas(div, {
        scale:           SCALE,
        useCORS:         true,
        allowTaint:      true,
        backgroundColor: '#ffffff',
        width:           RENDER_W,
        windowWidth:     RENDER_W,
        logging:         false,
      }).then(c => { clearTimeout(timer); resolve(c); })
        .catch(e => { clearTimeout(timer); reject(e); });
    });
  }

  // ── 把 canvas 按 A4 切页写入 PDF ──────────────────────────────────────────
  // 返回 { leftoverCanvas, leftoverH, pages }
  async function flushCanvas(pdf, canvas, isVeryFirst, loCanvas, loH) {
    const sliceH = Math.round(BODY_H * PX_PER_MM);

    // 拼接上一块末尾剩余
    let src;
    if (loH > 0 && loCanvas) {
      src = document.createElement('canvas');
      src.width  = canvas.width;
      src.height = loH + canvas.height;
      const ctx = src.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, src.width, src.height);
      ctx.drawImage(loCanvas, 0, 0);
      ctx.drawImage(canvas, 0, loH);
    } else {
      src = canvas;
    }

    const totalH = src.height;
    let offsetY = 0, pages = 0;

    while (totalH - offsetY >= sliceH) {
      if (!(isVeryFirst && pages === 0)) pdf.addPage();

      const pc = document.createElement('canvas');
      pc.width  = src.width;
      pc.height = sliceH;
      const ctx = pc.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, pc.width, pc.height);
      ctx.drawImage(src, 0, offsetY, src.width, sliceH, 0, 0, src.width, sliceH);
      pdf.addImage(pc.toDataURL('image/jpeg', 0.92), 'JPEG', ML, BODY_TOP, CW, BODY_H);

      offsetY += sliceH;
      pages++;
      await new Promise(r => setTimeout(r, 0));
    }

    const remH = totalH - offsetY;
    let newLo = null;
    if (remH > 0) {
      newLo = document.createElement('canvas');
      newLo.width  = src.width;
      newLo.height = remH;
      newLo.getContext('2d').drawImage(src, 0, offsetY, src.width, remH, 0, 0, src.width, remH);
    }
    return { leftoverCanvas: newLo, leftoverH: remH, pages };
  }

  // ── 页眉 / 页脚（书名用 Canvas API 渲染，避免中文乱码）────────────────────
  function makeHeaderCanvas(title) {
    const cw = Math.round((PW - ML - MR) * PX_PER_MM);
    const ch = Math.round(HEADER_H * PX_PER_MM);
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    // 分隔线
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = Math.round(0.35 * PX_PER_MM);
    const lineY = ch - Math.round(0.5 * PX_PER_MM);
    ctx.beginPath(); ctx.moveTo(0, lineY); ctx.lineTo(cw, lineY); ctx.stroke();
    // 书名文字
    const fs = Math.round(7 * PX_PER_MM * 0.352778); // 7pt → px
    ctx.font = fs + 'px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#828296';
    ctx.textBaseline = 'bottom';
    const displayTitle = title.length > 28 ? title.slice(0, 28) + '…' : title;
    ctx.textAlign = 'left';
    ctx.fillText(displayTitle, 0, ch - Math.round(2.5 * PX_PER_MM));
    ctx.textAlign = 'right';
    ctx.fillText('WeRead Export', cw, ch - Math.round(2.5 * PX_PER_MM));
    return cv;
  }

  function drawHeader(pdf, headerCanvas) {
    pdf.addImage(
      headerCanvas.toDataURL('image/png'), 'PNG',
      ML, MT, CW, HEADER_H
    );
  }

  function drawFooter(pdf, pageNum, total) {
    pdf.setDrawColor(210, 210, 225);
    pdf.setLineWidth(0.25);
    pdf.line(ML, PH - MB - FOOTER_H + 0.5, PW - MR, PH - MB - FOOTER_H + 0.5);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(170, 170, 185);
    pdf.text(pageNum + ' / ' + total, PW / 2, PH - MB - 1.5, { align: 'center' });
  }

  // ================================================================
  //  主流程
  // ================================================================
  try {
    setBar(3); setLog('读取采集数据…');

    const data = await storageGet();

    if (!data || !data.blocks || !data.blocks.length) {
      showError('未找到采集数据，请先在微信读书页面完成导出。');
      return;
    }

    const bookTitle = data.title || '未知书籍';
    const blocks    = data.blocks;
    document.title  = '生成《' + bookTitle + '》…';
    setLog('共 ' + blocks.length + ' 个块');
    setBar(8);

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });

    // ── 封面 ────────────────────────────────────────────────────────────────
    setLog('绘制封面…'); setBar(11);

    pdf.setFillColor(45, 40, 120);
    pdf.rect(0, 0, PW, PH * 0.55, 'F');
    pdf.setFillColor(79, 70, 229);
    pdf.rect(0, PH * 0.05, PW, PH * 0.45, 'F');
    pdf.setFillColor(124, 58, 237);
    pdf.rect(0, 0, PW, 4.5, 'F');

    const cardX = ML, cardY = PH * 0.12, cardW = CW, cardH = PH * 0.30;
    pdf.setFillColor(255, 255, 255);
    pdf.roundedRect(cardX, cardY, cardW, cardH, 6, 6, 'F');

    const tcvs = document.createElement('canvas');
    const tcW  = Math.round(cardW * PX_PER_MM);
    const tcH  = Math.round(cardH * PX_PER_MM);
    tcvs.width = tcW; tcvs.height = tcH;
    const tc = tcvs.getContext('2d');
    tc.fillStyle = '#fff'; tc.fillRect(0, 0, tcW, tcH);
    const fs = Math.max(28, Math.min(52, Math.round(tcW / Math.max(bookTitle.length, 4) * 0.9)));
    tc.font = `800 ${fs}px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",serif`;
    tc.fillStyle = '#1a1a2e'; tc.textAlign = 'center'; tc.textBaseline = 'middle';
    const maxLW = tcW - 48;
    let ln = '', lns = [];
    for (const ch of bookTitle) {
      const test = ln + ch;
      if (tc.measureText(test).width > maxLW && ln) { lns.push(ln); ln = ch; } else ln = test;
    }
    if (ln) lns.push(ln);
    const lhPx = fs * 1.5;
    const sy   = (tcH - lns.length * lhPx) / 2 + lhPx / 2;
    lns.forEach((l, i) => tc.fillText(l, tcW / 2, sy + i * lhPx));
    tc.font = `400 ${Math.round(fs * 0.38)}px "PingFang SC","Microsoft YaHei",sans-serif`;
    tc.fillStyle = '#8888aa';
    tc.fillText('微信读书导出', tcW / 2, tcH - 32);
    pdf.addImage(tcvs.toDataURL('image/png'), 'PNG', cardX, cardY, cardW, cardH);

    const infoY = PH * 0.55 + 14;
    pdf.setFont('helvetica', 'normal'); pdf.setTextColor(70, 70, 100); pdf.setFontSize(9);
    pdf.text('Source: WeChat Reading', PW / 2, infoY, { align: 'center' });
    pdf.setFontSize(8); pdf.setTextColor(130, 130, 160);
    const nd = new Date();
    pdf.text(nd.getFullYear() + '-' + String(nd.getMonth()+1).padStart(2,'0') + '-' + String(nd.getDate()).padStart(2,'0'), PW/2, infoY+9, {align:'center'});
    pdf.text(blocks.length + ' blocks', PW/2, infoY+17, {align:'center'});
    pdf.setFontSize(6.5); pdf.setTextColor(180, 180, 200);
    pdf.text('Generated by WeRead PDF Exporter', PW/2, PH-10, {align:'center'});

    // ── 正文分块渲染 ─────────────────────────────────────────────────────────
    setLog('开始渲染正文…'); setBar(15);

    // page 类型 = canvas 截图模式（每个 block 是一整张页面截图）
    const isPageMode = blocks.length > 0 && blocks.every(b => b.type === 'page');

    if (isPageMode) {
      for (let i = 0; i < blocks.length; i++) {
        pdf.addPage();
        const b = blocks[i];
        const imgW = b.width || 1, imgH = b.height || 1;
        const scale = Math.min(CW / imgW, BODY_H / imgH);
        const w = imgW * scale, h = imgH * scale;
        pdf.addImage(b.b64 || b.src, 'JPEG', ML + (CW - w) / 2, BODY_TOP + (BODY_H - h) / 2, w, h);
        setLog('写入截图页 ' + (i+1) + '/' + blocks.length);
        setBar(15 + Math.round((i+1) / blocks.length * 70));
        await new Promise(r => setTimeout(r, 0));
      }
    } else {

    const totalChunks = Math.ceil(blocks.length / CHUNK_BLOCKS);
    let loCanvas = null, loH = 0, isVeryFirst = true;

    pdf.addPage();

    for (let ci = 0; ci < totalChunks; ci++) {
      const slice = blocks.slice(ci * CHUNK_BLOCKS, (ci + 1) * CHUNK_BLOCKS);
      setLog('排版 ' + (ci+1) + '/' + totalChunks + '…');
      setBar(15 + Math.round(ci / totalChunks * 60));

      const div = buildDiv(slice, ci === 0);
      stage.innerHTML = '';
      stage.appendChild(div);

      await waitImgs(div);
      await new Promise(r => setTimeout(r, 100));

      setLog('截图 ' + (ci+1) + '/' + totalChunks + '…');
      const canvas = await renderOne(div);
      stage.innerHTML = '';

      const result = await flushCanvas(pdf, canvas, isVeryFirst, loCanvas, loH);
      loCanvas    = result.leftoverCanvas;
      loH         = result.leftoverH;
      isVeryFirst = false;

      setBar(15 + Math.round((ci+1) / totalChunks * 60));
    }

    // 最后一页（不足整页的剩余内容）
    if (loH > 0 && loCanvas) {
      if (!isVeryFirst) pdf.addPage();
      pdf.addImage(loCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', ML, BODY_TOP, CW, loH / PX_PER_MM);
    }
    } // end else (text mode)

    // ── 页眉页脚 ─────────────────────────────────────────────────────────────
    setLog('添加页眉页脚…'); setBar(88);
    const headerCanvas = makeHeaderCanvas(bookTitle);
    const totalPages   = pdf.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      pdf.setPage(p);
      if (p === 1) continue;
      drawHeader(pdf, headerCanvas);
      drawFooter(pdf, p - 1, totalPages - 1);
    }

    // ── 保存 ─────────────────────────────────────────────────────────────────
    setLog('写入文件…'); setBar(97);
    const safeName = bookTitle.replace(/[\/\\:*?"<>|]/g, '_');
    pdf.save(safeName + '.pdf');

    await storageClear();
    showDone(safeName);

  } catch (err) {
    showError(err.message || String(err));
  }
})();
