/**
 * ModelHub — desktop-friendly model resource browser.
 * Vanilla JS, zero dependencies.
 */
(function () {
  'use strict';

  const MODEL_EXTENSIONS = new Set([
    '.pb', '.h5', '.ckpt',
    '.pt', '.pth',
    '.onnx', '.tflite',
    '.pkl', '.joblib',
    '.bin', '.safetensors',
    '.gguf', '.ggml'
  ]);

  const COLUMN_COUNT = 4;
  const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
  const MARK = /\p{M}/u;
  const searchCache = new WeakMap();
  const state = {
    query: '',
    items: [],
    updatedAt: '',
    loading: false,
    error: '',
    page: 1,
    pageSize: 48
  };

  const $ = (selector) => document.querySelector(selector);

  const dom = {
    searchInput: $('#searchInput'),
    clearBtn: $('#clearBtn'),
    syncStatus: $('#syncStatus'),
    statsBar: $('#statsBar'),
    loading: $('#loading'),
    errorState: $('#errorState'),
    errorMsg: $('#errorMsg'),
    retryBtn: $('#retryBtn'),
    emptyState: $('#emptyState'),
    emptyMsg: $('#emptyMsg'),
    fileList: $('#fileList'),
    pagination: $('#pagination'),
    toast: $('#toast')
  };

  function getFileExtension(filename) {
    const dot = String(filename || '').lastIndexOf('.');
    return dot >= 0 ? String(filename).slice(dot).toLowerCase() : '';
  }

  function hasModelExtension(filename) {
    return MODEL_EXTENSIONS.has(getFileExtension(filename));
  }

  // Keep search behavior aligned with CloudFileRelayAndroid:
  // punctuation is treated as a separator, keywords use AND semantics,
  // and typo-tolerant subsequence matching is used only as a fallback.
  function normalizeForSearch(value) {
    if (value == null || value === '') return '';
    const source = String(value).normalize('NFKD').toLowerCase();
    let output = '';
    let previousSpace = true;
    for (const character of source) {
      if (MARK.test(character)) continue;
      if (LETTER_OR_NUMBER.test(character)) {
        output += character;
        previousSpace = false;
      } else if (!previousSpace) {
        output += ' ';
        previousSpace = true;
      }
    }
    return output.trim();
  }

  function tokens(query) {
    const normalized = normalizeForSearch(query);
    if (!normalized) return [];
    return [...new Set(normalized.split(/\s+/).filter(Boolean))];
  }

  function searchFields(item) {
    let fields = searchCache.get(item);
    if (fields) return fields;
    const filename = String(item.filename || '');
    const normalizedName = String(item.normalized_name || filename);
    const searchText = normalizeForSearch(`${filename} ${normalizedName}`);
    fields = { searchText, compact: searchText.replace(/\s/g, '') };
    searchCache.set(item, fields);
    return fields;
  }

  function scoreToken(item, token, allowFuzzy) {
    if (!token) return 0;
    const { searchText, compact } = searchFields(item);
    if (searchText === token) return 180;
    if (searchText.startsWith(token + ' ') || searchText.startsWith(token)) return 145;
    if (searchText.includes(` ${token} `) || searchText.endsWith(` ${token}`)) return 135;
    if (searchText.includes(token)) return 115;

    const compactToken = token.replace(/\s/g, '');
    if (compact.includes(compactToken)) return 105;
    if (!allowFuzzy || compactToken.length < 3) return -1;
    const fuzzy = subsequenceScore(compact, compactToken);
    return fuzzy < 0 ? -1 : 35 + fuzzy;
  }

  function subsequenceScore(text, token) {
    let textIndex = 0;
    let previous = -1;
    let totalGap = 0;
    let longestGap = 0;
    for (let index = 0; index < token.length; index += 1) {
      const found = text.indexOf(token[index], textIndex);
      if (found < 0) return -1;
      if (previous >= 0) {
        const gap = found - previous - 1;
        totalGap += gap;
        longestGap = Math.max(longestGap, gap);
      }
      previous = found;
      textIndex = found + 1;
    }
    if (longestGap > 12 || totalGap > Math.max(18, token.length * 4)) return -1;
    return Math.max(1, 28 - totalGap - Math.floor(Math.max(0, text.length - token.length) / 14));
  }

  function collectMatches(source, queryTokens, allowFuzzy) {
    const compactPhrase = queryTokens.join('');
    const matches = [];
    source.forEach((item) => {
      let score = 0;
      let matched = true;
      for (const token of queryTokens) {
        const tokenScore = scoreToken(item, token, allowFuzzy);
        if (tokenScore < 0) {
          matched = false;
          break;
        }
        score += tokenScore;
      }
      if (!matched) return;
      if (searchFields(item).compact.includes(compactPhrase)) score += 45;
      matches.push({ item, score });
    });
    return matches;
  }

  function searchItems(source, query) {
    const queryTokens = tokens(query);
    if (queryTokens.length === 0) return [...source];

    let matches = collectMatches(source, queryTokens, false);
    if (matches.length === 0) matches = collectMatches(source, queryTokens, true);
    matches.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftTime = Date.parse(left.item.completed_at || '') || 0;
      const rightTime = Date.parse(right.item.completed_at || '') || 0;
      if (rightTime !== leftTime) return rightTime - leftTime;
      return String(left.item.filename || '').localeCompare(String(right.item.filename || ''));
    });
    return matches.map((result) => result.item);
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function escapeAttr(value) {
    return escapeHtml(value)
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      const date = new Date(iso);
      const pad = (number) => String(number).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    } catch (_) {
      return String(iso);
    }
  }

  function relativeTime(iso) {
    if (!iso) return '时间未知';
    try {
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 0) return formatTime(iso);
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return '刚刚更新';
      if (mins < 60) return `${mins} 分钟前`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours} 小时前`;
      const days = Math.floor(hours / 24);
      if (days < 30) return `${days} 天前`;
      return formatTime(iso);
    } catch (_) {
      return String(iso);
    }
  }

  function showToast(message, duration = 2200) {
    clearTimeout(showToast.timer);
    dom.toast.textContent = message;
    dom.toast.classList.add('show');
    showToast.timer = setTimeout(() => dom.toast.classList.remove('show'), duration);
  }

  function openResource(url) {
    if (!url) {
      showToast('链接为空');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function highlightFilename(filename, query) {
    const queryTokens = tokens(query);
    if (queryTokens.length === 0) return escapeHtml(filename);

    const lowerFilename = filename.toLocaleLowerCase();
    const ranges = [];
    queryTokens.forEach((token) => {
      let from = 0;
      while (from < lowerFilename.length) {
        const found = lowerFilename.indexOf(token, from);
        if (found < 0) break;
        ranges.push([found, found + token.length]);
        from = found + token.length;
      }
    });
    if (ranges.length === 0) return escapeHtml(filename);

    ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const merged = [];
    ranges.forEach(([start, end]) => {
      const last = merged[merged.length - 1];
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    });

    let output = '';
    let cursor = 0;
    merged.forEach(([start, end]) => {
      output += escapeHtml(filename.slice(cursor, start));
      output += `<mark class="keyword-highlight">${escapeHtml(filename.slice(start, end))}</mark>`;
      cursor = end;
    });
    return output + escapeHtml(filename.slice(cursor));
  }

  function renderCard(item, query) {
    const filename = String(item.filename || '未命名文件');
    const shareUrl = String(item.share_url || '');

    return `
      <article class="file-card" tabindex="0" role="link" data-url="${escapeAttr(shareUrl)}" aria-label="打开 ${escapeAttr(filename)}">
        <h3 class="card-filename" title="${escapeAttr(filename)}">${highlightFilename(filename, query)}</h3>
      </article>`;
  }

  function renderColumn(items, query) {
    const cards = items.length
      ? items.map(({ item }) => renderCard(item, query)).join('')
      : '';

    return `
      <section class="file-column">
        <div class="column-list">${cards}</div>
      </section>`;
  }

  function renderBoard(items, query) {
    const columns = Array.from({ length: COLUMN_COUNT }, () => []);
    items.forEach((item, index) => columns[index % COLUMN_COUNT].push({ item }));
    return columns.map((column) => renderColumn(column, query)).join('');
  }

  function renderPagination(totalPages, totalItems) {
    if (totalItems <= 0) {
      dom.pagination.innerHTML = '';
      return;
    }

    const pageSizeOptions = [12, 24, 48, 96, 192];
    const options = pageSizeOptions
      .map((size) => `<option value="${size}" ${size === state.pageSize ? 'selected' : ''}>${size}</option>`)
      .join('');
    const navigation = totalPages > 1 ? `
        <div class="page-navigation">
          <button class="page-btn" type="button" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''} aria-label="上一页">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m14.5 6-6 6 6 6"></path></svg>
          </button>
          <span class="page-info">
            <input type="number" class="page-jump" id="pageJump" value="${state.page}" min="1" max="${totalPages}" aria-label="跳转到页码" enterkeyhint="go">
            <span>/ ${totalPages}</span>
          </span>
          <button class="page-btn" type="button" data-page="${state.page + 1}" ${state.page >= totalPages ? 'disabled' : ''} aria-label="下一页">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9.5 6 6 6-6 6"></path></svg>
          </button>
        </div>` : '';

    dom.pagination.innerHTML = `
      <div class="pagination">
        <label class="page-size-control" for="pageSizeSelect">
          <span>每页显示</span>
          <select id="pageSizeSelect" class="page-size-select" aria-label="每页显示条数">${options}</select>
          <span>条</span>
        </label>
        ${navigation}
      </div>`;
  }

  function setView(view) {
    dom.loading.hidden = view !== 'loading';
    dom.errorState.hidden = view !== 'error';
    dom.emptyState.hidden = view !== 'empty';
    dom.fileList.hidden = view !== 'list';
  }

  function scrollContentToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function render() {
    const modelItems = state.items.filter((item) => hasModelExtension(item.filename));
    const filtered = searchItems(modelItems, state.query);

    const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
    state.page = Math.min(state.page, totalPages);
    const start = (state.page - 1) * state.pageSize;
    const pageItems = filtered.slice(start, start + state.pageSize);

    if (state.error && filtered.length === 0 && !state.loading) {
      setView('error');
      dom.errorMsg.textContent = state.error;
    } else if (state.loading && filtered.length === 0) {
      setView('loading');
    } else if (filtered.length === 0) {
      setView('empty');
      dom.emptyMsg.textContent = state.query
        ? `未找到同时匹配这些关键词的模型文件`
        : '暂无模型文件记录';
    } else {
      setView('list');
      dom.fileList.innerHTML = renderBoard(pageItems, state.query);
    }

    const totalModels = state.items.filter((item) => hasModelExtension(item.filename)).length;
    dom.statsBar.innerHTML = state.query
      ? `找到 <strong>${filtered.length}</strong> 条结果（共 ${totalModels} 条模型资源）`
      : `共 <strong>${totalModels}</strong> 条模型资源 · 当前展示 ${pageItems.length} 条`;

    renderPagination(totalPages, filtered.length);

    if (state.updatedAt) {
      dom.syncStatus.textContent = `更新于 ${relativeTime(state.updatedAt)}`;
    } else {
      dom.syncStatus.textContent = '';
    }
  }

  async function loadFiles() {
    state.loading = true;
    state.error = '';
    render();

    try {
      const response = await fetch(`./data/sync_cache.json?_=${Date.now()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      if (!data.items || !Array.isArray(data.items)) {
        throw new Error('数据格式错误');
      }

      state.items = data.items;
      state.updatedAt = data.updatedAt || '';
    } catch (error) {
      console.error('Fetch error:', error);
      state.error = '暂无数据，请稍后重试';
    } finally {
      state.loading = false;
      render();
    }
  }

  function onSearchInput() {
    state.query = dom.searchInput.value.trim();
    state.page = 1;
    dom.clearBtn.hidden = !state.query;
    render();
  }

  function onAppClick(event) {
    const pageButton = event.target.closest('.page-btn');
    if (pageButton && !pageButton.disabled) {
      const targetPage = Number(pageButton.dataset.page);
      if (targetPage >= 1) {
        state.page = targetPage;
        render();
        scrollContentToTop();
      }
      return;
    }

    const card = event.target.closest('.file-card');
    if (card) openResource(card.dataset.url);
  }

  function onPaginationChange(event) {
    if (event.target.id !== 'pageSizeSelect') return;
    const nextPageSize = Number(event.target.value);
    if (!Number.isFinite(nextPageSize) || nextPageSize <= 0 || nextPageSize === state.pageSize) return;
    state.pageSize = nextPageSize;
    state.page = 1;
    render();
    scrollContentToTop();
  }

  function onAppKeydown(event) {
    if (event.key === 'Enter' && event.target.id === 'pageJump') {
      const value = Number(event.target.value);
      const max = Number(event.target.max);
      if (value >= 1 && value <= max) {
        state.page = value;
        render();
        scrollContentToTop();
      } else {
        event.target.value = state.page;
      }
      return;
    }

    const card = event.target.closest('.file-card');
    if (card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openResource(card.dataset.url);
    }
  }

  function init() {
    dom.searchInput.addEventListener('input', onSearchInput);
    dom.searchInput.addEventListener('focus', () => dom.searchInput.parentElement.classList.add('focused'));
    dom.searchInput.addEventListener('blur', () => dom.searchInput.parentElement.classList.remove('focused'));

    dom.clearBtn.addEventListener('click', () => {
      dom.searchInput.value = '';
      state.query = '';
      state.page = 1;
      dom.clearBtn.hidden = true;
      render();
      dom.searchInput.focus();
    });

    dom.retryBtn.addEventListener('click', loadFiles);
    document.getElementById('app').addEventListener('click', onAppClick);
    document.getElementById('app').addEventListener('keydown', onAppKeydown);
    dom.pagination.addEventListener('change', onPaginationChange);

    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && document.activeElement !== dom.searchInput && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const tagName = document.activeElement && document.activeElement.tagName;
        if (tagName !== 'INPUT' && tagName !== 'TEXTAREA') {
          event.preventDefault();
          dom.searchInput.focus();
        }
      }
      if (event.key === 'Escape' && document.activeElement === dom.searchInput) {
        dom.searchInput.value = '';
        state.query = '';
        state.page = 1;
        dom.clearBtn.hidden = true;
        render();
      }
    });

    loadFiles();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
