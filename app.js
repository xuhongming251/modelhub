/**
 * ModelHub — Frontend Application
 *
 * Vanilla JS, zero dependencies. Mobile-first design with:
 * - Real-time filename search
 * - Channel filter chips
 * - Copy-to-clipboard with toast feedback
 * - Dark mode support (follows OS preference)
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  const state = {
    query: '',
    items: [],
    updatedAt: '',
    loading: false,
    error: '',
    stale: false,
    message: '',
    page: 1,
    pageSize: 20
  };

  // ── DOM helpers ────────────────────────────────────────────────────────
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    searchInput:  $('#searchInput'),
    clearBtn:     $('#clearBtn'),
    syncStatus:   $('#syncStatus'),
    statsBar:     $('#statsBar'),
    loading:      $('#loading'),
    errorState:   $('#errorState'),
    errorMsg:     $('#errorMsg'),
    retryBtn:     $('#retryBtn'),
    emptyState:   $('#emptyState'),
    emptyMsg:     $('#emptyMsg'),
    fileList:     $('#fileList'),
    channelFilter:$('#channelFilter'),
    toast:        $('#toast')
  };

  // ── Scroll helper ─────────────────────────────────────────────────────
  function scrollContentToTop() {
    const el = [dom.fileList, dom.loading, dom.errorState, dom.emptyState]
      .find(e => e.style.display !== 'none');
    if (el) el.scrollTop = 0;
  }

// ── Toast ──────────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg, duration = 2000) {
    clearTimeout(toastTimer);
    dom.toast.textContent = msg;
    dom.toast.classList.add('show');
    toastTimer = setTimeout(() => {
      dom.toast.classList.remove('show');
    }, duration);
  }

  // ── Copy to clipboard ─────────────────────────────────────────────────
  async function copyText(text, label) {
    if (!text) {
      showToast('链接为空');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast(label + ' 已复制');
    } catch (e) {
      // Fallback for older browsers / non-HTTPS
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast(label + ' 已复制');
      } catch (_) {
        showToast('复制失败，请手动选择');
      }
      document.body.removeChild(ta);
    }
  }

  // ── Formatting ────────────────────────────────────────────────────────
  function formatTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch (_) {
      return iso;
    }
  }

  function relativeTime(iso) {
    if (!iso) return '';
    try {
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 0) return formatTime(iso);
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return '刚刚';
      if (mins < 60) return `${mins} 分钟前`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours} 小时前`;
      const days = Math.floor(hours / 24);
      if (days < 30) return `${days} 天前`;
      return formatTime(iso);
    } catch (_) {
      return iso;
    }
  }

  // ── Escape ─────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Render ─────────────────────────────────────────────────────────────
  function renderCard(item) {
    const name = escapeHtml(item.filename);
    const share = escapeAttr(item.share_url);
    const timeStr = formatTime(item.completed_at);
    const relStr  = relativeTime(item.completed_at);

    return `
      <div class="file-card">
        <div class="card-filename" title="${escapeHtml(item.filename)}">${name}</div>
        <div class="card-footer">
          <span class="card-time" title="${escapeHtml(timeStr)}">${escapeHtml(relStr)}</span>
          <button class="btn-action btn-share" data-url="${share}">转存网盘</button>
        </div>
      </div>`;
  }

  function render() {
    // Apply search filter (client-side)
    let filtered = state.items;
    if (state.query) {
      const q = state.query.toLowerCase();
      filtered = filtered.filter(i =>
        i.filename.toLowerCase().includes(q) ||
        (i.normalized_name && i.normalized_name.includes(q))
      );
    }

    const totalFiltered = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / state.pageSize));

    // Clamp page to valid range
    if (state.page > totalPages) state.page = totalPages;

    // Slice for current page
    const start = (state.page - 1) * state.pageSize;
    const pageItems = filtered.slice(start, start + state.pageSize);

    // Decide which state view to show
    if (state.error && filtered.length === 0 && !state.loading) {
      setView('error');
      dom.errorMsg.textContent = state.error;
    } else if (state.loading && filtered.length === 0) {
      setView('loading');
    } else if (filtered.length === 0) {
      setView('empty');
      dom.emptyMsg.textContent = state.query
        ? `未找到包含「${state.query}」的文件`
        : '暂无文件记录';
    } else {
      setView('list');
      dom.fileList.innerHTML = pageItems.map(renderCard).join('');
    }

    // Update stats bar
    if (state.query && filtered.length !== state.items.length) {
      dom.statsBar.textContent = `找到 ${totalFiltered} 条（共 ${state.items.length} 条）`;
    } else {
      dom.statsBar.textContent = `共 ${state.items.length} 条记录`;
    }

    // Pagination
    renderPagination(state.page, totalPages, totalFiltered);

    // Update sync status in header
    if (state.updatedAt) {
      dom.syncStatus.textContent = '更新于 ' + relativeTime(state.updatedAt);
      dom.syncStatus.className = 'header-sync';
    } else {
      dom.syncStatus.textContent = '';
      dom.syncStatus.className = 'header-sync';
    }
  }

  function renderPagination(page, totalPages) {
    let el = $('#pagination');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pagination';
      document.querySelector('#app').appendChild(el);
    }
    if (totalPages <= 1) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML =
      '<div class="pagination">' +
      `<button class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹</button>` +
      `<span class="page-info"><input type="number" class="page-jump" id="pageJump" value="${page}" min="1" max="${totalPages}" enterkeyhint="go"> / ${totalPages}</span>` +
      `<button class="page-btn" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>›</button>` +
      '</div>';
  }

  function setView(view) {
    dom.loading.style.display    = view === 'loading' ? 'flex' : 'none';
    dom.errorState.style.display = view === 'error'   ? 'flex' : 'none';
    dom.emptyState.style.display = view === 'empty'   ? 'flex' : 'none';
    dom.fileList.style.display   = view === 'list'    ? 'flex' : 'none';
  }

  // ── Data fetching ─────────────────────────────────────────────────────
  async function loadFiles() {
    state.loading = true;
    state.error = '';
    render();

    try {
      const resp = await fetch('./data/sync_cache.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();

      // Static cache file format: { version, items, updatedAt, ... }
      if (data.items && Array.isArray(data.items)) {
        state.items     = data.items || [];
        state.updatedAt = data.updatedAt || '';
        state.error     = '';
      } else {
        state.error = '数据格式错误';
      }
    } catch (err) {
      console.error('Fetch error:', err);
      state.error = '暂无数据，请稍后重试';
    } finally {
      state.loading = false;
      render();
    }
  }

  // ── Search (client-side only — instant filtering) ─────────────────────
  function onSearchInput() {
    state.query = dom.searchInput.value.trim();
    state.page = 1;
    dom.clearBtn.style.display = state.query ? 'flex' : 'none';
    render();
  }

  // ── Card event delegation ─────────────────────────────────────────────
  function onCardClick(e) {
    // Pagination button clicks
    const pageBtn = e.target.closest('.page-btn');
    if (pageBtn && !pageBtn.disabled) {
      const targetPage = parseInt(pageBtn.dataset.page);
      if (targetPage >= 1) {
        state.page = targetPage;
        render();
        scrollContentToTop();
      }
      return;
    }

    // Card button click — open share URL
    const btn = e.target.closest('.btn-share');
    if (btn && btn.dataset.url) {
      window.open(btn.dataset.url, '_blank', 'noopener,noreferrer');
      return;
    }

    // Card body click — also open share URL
    const card = e.target.closest('.file-card');
    if (card) {
      const shareBtn = card.querySelector('.btn-share');
      if (shareBtn && shareBtn.dataset.url) {
        window.open(shareBtn.dataset.url, '_blank', 'noopener,noreferrer');
      }
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────
  function init() {
    // Search input
    dom.searchInput.addEventListener('input', onSearchInput);
    dom.searchInput.addEventListener('focus', function () {
      dom.searchInput.parentElement.classList.add('focused');
    });
    dom.searchInput.addEventListener('blur', function () {
      dom.searchInput.parentElement.classList.remove('focused');
    });

    // Clear button (client-side filter clear, no API call)
    dom.clearBtn.addEventListener('click', function () {
      dom.searchInput.value = '';
      state.query = '';
      state.page = 1;
      dom.clearBtn.style.display = 'none';
      render();
      dom.searchInput.focus();
    });

    // Retry button (error state)
    dom.retryBtn.addEventListener('click', function () {
      loadFiles();
    });

    // Event delegation (cards + pagination)
    document.getElementById('app').addEventListener('click', onCardClick);
    document.getElementById('app').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && e.target.id === 'pageJump') {
        const v = parseInt(e.target.value);
        const max = parseInt(e.target.max);
        if (v >= 1 && v <= max) {
          state.page = v;
          render();
          scrollContentToTop();
        } else {
          e.target.value = state.page;
        }
      }
    });

    // Keyboard: Escape clears search (client-side only)
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.activeElement === dom.searchInput) {
        dom.searchInput.value = '';
        state.query = '';
        state.page = 1;
        dom.clearBtn.style.display = 'none';
        dom.searchInput.blur();
        render();
      }
    });

    // Initial load
    loadFiles();
  }

  // ── Start ──────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
