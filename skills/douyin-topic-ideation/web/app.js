/* 选题库管理面板 —— Vue 3（global build）+ Tailwind + Flowbite 样式 */

const { createApp } = Vue;

const 定位们 = ['泛选题', '人设选题', '转化选题'];
const 路径们 = ['晒过程', '聊观点', '讲故事', '教知识'];
const 元素们 = ['成本', '人群', '猎奇', '对比', '最差', '头牌', '怀旧', '荷尔蒙'];

const BADGE = {
  泛选题: 'badge badge-generic',
  人设选题: 'badge badge-persona',
  转化选题: 'badge badge-convert',
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function emptyTopic() {
  return {
    id: null,
    主题: '',
    看点: '',
    内容定位: '泛选题',
    创作路径: '聊观点',
    爆款元素: [],
    结构: [
      { 段名: '', 要点: '' },
      { 段名: '', 要点: '' },
      { 段名: '', 要点: '' },
    ],
    收藏: false,
    标签: [],
    备注: '',
    来源: {},
  };
}

createApp({
  data() {
    return {
      loading: true,
      error: null,
      topics: [],
      account: null,
      accountDraft: null,
      定位们,
      路径们,
      元素们,
      filter: { 视图: '全部', 内容定位: '全部', q: '' },
      expanded: {},
      editing: null,
      editingTags: '',
      saving: false,
      toast: null,
      showAccount: false,
      exportOpen: false,
      deleting: null,
      selected: [],
      page: 1,
      perPage: 20,
    };
  },

  computed: {
    stats() {
      const 定位数 = (k) => this.topics.filter((t) => t.内容定位 === k).length;
      return {
        总数: this.topics.length,
        收藏: this.topics.filter((t) => t.收藏).length,
        泛: 定位数('泛选题'),
        人: 定位数('人设选题'),
        转: 定位数('转化选题'),
      };
    },
    filtered() {
      const q = this.filter.q.trim().toLowerCase();
      return this.topics.filter((t) => {
        if (this.filter.视图 === '收藏' && !t.收藏) return false;
        if (this.filter.内容定位 !== '全部' && t.内容定位 !== this.filter.内容定位) return false;
        if (!q) return true;
        const hay = [t.主题, t.看点, (t.标签 ?? []).join(' '), t.备注, t.来源?.话题, t.来源?.观众]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    },
    accountReady() {
      return !!(this.account?.赛道 && this.account?.目标人群);
    },
    allSelected() {
      const list = this.pagedList;
      return list.length > 0 && list.every((t) => this.selected.includes(t.id));
    },
    pagedList() {
      if (!this.perPage) return this.filtered;
      const start = (this.currentPage - 1) * this.perPage;
      return this.filtered.slice(start, start + this.perPage);
    },
    totalPages() {
      return this.perPage ? Math.max(1, Math.ceil(this.filtered.length / this.perPage)) : 1;
    },
    // 页码夹紧：删除或筛选后 page 可能越界，渲染时以 currentPage 为准
    currentPage() {
      return Math.min(Math.max(1, this.page), this.totalPages);
    },
    rangeFrom() {
      if (!this.filtered.length) return 0;
      return this.perPage ? (this.currentPage - 1) * this.perPage + 1 : 1;
    },
    rangeTo() {
      if (!this.filtered.length) return 0;
      return this.perPage ? Math.min(this.currentPage * this.perPage, this.filtered.length) : this.filtered.length;
    },
    // 页数多时首尾 + 当前附近，中间用 …
    pageItems() {
      const total = this.totalPages;
      const cur = this.currentPage;
      if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
      const kept = [...new Set([1, total, cur - 1, cur, cur + 1])]
        .filter((n) => n >= 1 && n <= total)
        .sort((a, b) => a - b);
      const out = [];
      let prev = 0;
      for (const n of kept) {
        if (n - prev > 1) out.push('…');
        out.push(n);
        prev = n;
      }
      return out;
    },
  },

  watch: {
    filter: {
      deep: true,
      handler() {
        this.page = 1;
      },
    },
    perPage() {
      this.page = 1;
    },
  },

  methods: {
    badge(cls, value) {
      return BADGE[value] ?? 'badge badge-path';
    },

    async load() {
      this.loading = true;
      this.error = null;
      try {
        const [topics, account] = await Promise.all([api('/api/topics'), api('/api/account')]);
        this.topics = topics.选题 ?? [];
        this.account = account;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    notify(msg, kind = 'ok') {
      this.toast = { msg, kind };
      setTimeout(() => { this.toast = null; }, 2200);
    },

    toggle(id) {
      this.expanded[id] = !this.expanded[id];
    },

    openNew() {
      this.editing = emptyTopic();
      this.editingTags = '';
    },

    openEdit(t) {
      this.editing = JSON.parse(JSON.stringify(t));
      this.editingTags = (t.标签 ?? []).join(', ');
    },

    closeEdit() {
      this.editing = null;
      this.editingTags = '';
    },

    addStep() {
      if (this.editing.结构.length >= 5) return;
      this.editing.结构.push({ 段名: '', 要点: '' });
    },

    removeStep(i) {
      if (this.editing.结构.length <= 3) return;
      this.editing.结构.splice(i, 1);
    },

    toggleElement(el) {
      const arr = this.editing.爆款元素;
      const i = arr.indexOf(el);
      if (i >= 0) arr.splice(i, 1);
      else if (arr.length < 2) arr.push(el);
      else this.notify('最多选 2 个爆款元素', 'warn');
    },

    async save() {
      const t = this.editing;
      if (!t.主题.trim() || !t.看点.trim()) {
        this.notify('主题和看点不能为空', 'warn');
        return;
      }
      this.saving = true;
      try {
        const payload = { ...t, 标签: this.editingTags.split(/[,，;；|]/).map((s) => s.trim()).filter(Boolean) };
        if (t.id) {
          const updated = await api(`/api/topics/${t.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
          const i = this.topics.findIndex((x) => x.id === t.id);
          if (i >= 0) this.topics.splice(i, 1, updated);
          this.notify('已保存');
        } else {
          delete payload.id;
          const created = await api('/api/topics', { method: 'POST', body: JSON.stringify(payload) });
          this.topics.push(created);
          this.notify('已新增');
        }
        this.closeEdit();
      } catch (e) {
        this.notify(`保存失败：${e.message}`, 'err');
      } finally {
        this.saving = false;
      }
    },

    async toggleFavorite(t) {
      const next = !t.收藏;
      try {
        const updated = await api(`/api/topics/${t.id}`, { method: 'PATCH', body: JSON.stringify({ 收藏: next }) });
        const i = this.topics.findIndex((x) => x.id === t.id);
        if (i >= 0) this.topics.splice(i, 1, updated);
        this.notify(next ? '已收藏' : '已取消收藏');
      } catch (e) {
        this.notify(`失败：${e.message}`, 'err');
      }
    },

    toggleExport() {
      this.exportOpen = !this.exportOpen;
    },

    pickExport(kind) {
      this.exportOpen = false;
      this.exportAs(kind);
    },

    isSelected(id) {
      return this.selected.includes(id);
    },

    toggleSelect(id) {
      const i = this.selected.indexOf(id);
      if (i >= 0) this.selected.splice(i, 1);
      else this.selected.push(id);
    },

    selectAll() {
      const ids = this.pagedList.map((t) => t.id);
      if (this.allSelected) this.selected = this.selected.filter((id) => !ids.includes(id));
      else this.selected = Array.from(new Set([...this.selected, ...ids]));
    },

    goPage(n) {
      this.page = Math.max(1, Math.min(this.totalPages, n));
    },

    drop(t) {
      this.deleting = [t];
    },

    dropSelected() {
      const list = this.topics.filter((t) => this.selected.includes(t.id));
      if (list.length) this.deleting = list;
    },

    async doDrop() {
      const list = this.deleting;
      if (!list || !list.length) return;
      this.deleting = null;
      const ids = list.map((t) => t.id);
      try {
        if (ids.length === 1) await api(`/api/topics/${ids[0]}`, { method: 'DELETE' });
        else await api('/api/topics/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
        this.topics = this.topics.filter((x) => !ids.includes(x.id));
        this.selected = this.selected.filter((id) => !ids.includes(id));
        this.page = Math.max(1, Math.min(this.page, this.totalPages));
        this.notify(`已删除 ${ids.length} 条`);
      } catch (e) {
        this.notify(`删除失败：${e.message}`, 'err');
      }
    },

    download(name, text, mime) {
      const blob = new Blob([text], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },

    exportAs(kind) {
      // 按当前筛选结果导出，不是全库
      const list = this.filtered;
      if (kind === 'json') {
        this.download('选题.json', JSON.stringify({ 版本: 1, 选题: list }, null, 2), 'application/json');
      } else if (kind === 'csv') {
        const esc = (v) => {
          const s = String(v ?? '');
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const head = ['主题', '看点', '内容定位', '创作路径', '爆款元素', '收藏', '标签', '备注', '来源报告'];
        const rows = list.map((t) => [
          t.主题, t.看点, t.内容定位, t.创作路径, (t.爆款元素 ?? []).join('/'),
          t.收藏 ? '是' : '', (t.标签 ?? []).join('/'), t.备注 ?? '', t.来源?.报告 ?? '',
        ]);
        const csv = '\ufeff' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
        this.download('选题.csv', csv, 'text/csv');
      } else {
        const md = list.map((t) => {
          const lines = [`## ${t.收藏 ? '★ ' : ''}${t.主题}`, '', `- 看点：${t.看点}`,
            `- 定位：${t.内容定位} ｜ 路径：${t.创作路径} ｜ 元素：${(t.爆款元素 ?? []).join('、')}`];
          if (t.结构?.length) {
            lines.push('');
            t.结构.forEach((s, i) => lines.push(`${i + 1}. **${s.段名}**：${s.要点}`));
          }
          if (t.备注) lines.push('', `> ${t.备注}`);
          return lines.join('\n');
        }).join('\n\n');
        this.download('选题.md', md, 'text/markdown');
      }
      this.notify(`已导出 ${list.length} 条`);
    },

    openAccount() {
      this.accountDraft = this.account
        ? JSON.parse(JSON.stringify(this.account))
        : { 赛道: '', 目标人群: '', 变现途径: [], '专长/职业': [], 补充: '' };
      if (!Array.isArray(this.accountDraft.变现途径)) this.accountDraft.变现途径 = [];
      if (!Array.isArray(this.accountDraft['专长/职业'])) this.accountDraft['专长/职业'] = [];
      this.accountDraft.变现途径文本 = this.accountDraft.变现途径.join(', ');
      this.accountDraft.专长文本 = this.accountDraft['专长/职业'].join(', ');
      this.showAccount = true;
    },

    async saveAccount() {
      const d = this.accountDraft;
      const payload = {
        赛道: d.赛道,
        目标人群: d.目标人群,
        变现途径: String(d.变现途径文本 ?? '').split(/[,，;；|]/).map((s) => s.trim()).filter(Boolean),
        '专长/职业': String(d.专长文本 ?? '').split(/[,，;；|]/).map((s) => s.trim()).filter(Boolean),
        补充: d.补充 ?? '',
      };
      try {
        this.account = await api('/api/account', { method: 'POST', body: JSON.stringify(payload) });
        this.showAccount = false;
        this.notify('账号档案已保存');
      } catch (e) {
        this.notify(`保存失败：${e.message}`, 'err');
      }
    },
  },

  mounted() {
    this.load();
    document.addEventListener('click', (e) => {
      if (this.exportOpen && !e.target.closest('.export-menu')) this.exportOpen = false;
    });
  },

  template: `
<div class="min-h-screen">
  <header class="bg-gray-900 border-b border-gray-800 sticky top-0 z-20">
    <div class="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
      <div class="flex-1">
        <h1 class="text-lg font-medium text-gray-100">抖音爆款选题</h1>
        <p class="text-xs text-gray-400 mt-0.5">
          <template v-if="accountReady">
            {{ account.赛道 }} ｜ {{ account.目标人群 }}
            <span v-if="account.推断字段 && account.推断字段.length" class="text-amber-400">（含推断字段，建议核对）</span>
          </template>
          <template v-else>
            <span class="text-amber-400">账号档案未配置</span> —— 人设与转化选题会缺底座
          </template>
        </p>
      </div>
      <button class="btn btn-ghost" @click="openAccount">账号档案</button>
      <button class="btn btn-primary" @click="openNew">新建选题</button>
    </div>
  </header>

  <div class="max-w-6xl mx-auto px-6 py-6">
    <div class="grid grid-cols-3 gap-3 mb-6">
      <div class="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
        <div class="text-xs text-gray-400">总数</div>
        <div class="text-2xl font-medium text-gray-100">{{ stats.总数 }}</div>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
        <div class="text-xs text-gray-400">收藏</div>
        <div class="text-2xl font-medium text-amber-400">{{ stats.收藏 }}</div>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
        <div class="text-xs text-gray-400">配比（泛 / 人 / 转）</div>
        <div class="text-2xl font-medium text-gray-100">{{ stats.泛 }} · {{ stats.人 }} · {{ stats.转 }}</div>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-3 mb-5">
      <div class="inline-flex rounded-lg border border-gray-800 overflow-hidden bg-gray-900">
        <button v-for="s in ['全部', '收藏']" :key="s"
          class="px-3 py-1.5 text-sm border-r border-gray-800 last:border-r-0"
          :class="filter.视图 === s ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800'"
          @click="filter.视图 = s">{{ s }}</button>
      </div>
      <select v-model="filter.内容定位" class="field w-auto">
        <option value="全部">全部定位</option>
        <option v-for="d in 定位们" :key="d" :value="d">{{ d }}</option>
      </select>
      <input v-model="filter.q" class="field w-64" placeholder="搜索主题 / 看点 / 标签 / 来源" />
      <span class="text-xs text-gray-400">{{ filtered.length }} / {{ topics.length }} 条</span>
      <label class="inline-flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
        <input type="checkbox" class="row-check" :checked="allSelected" @change="selectAll" />
        全选本页
      </label>
      <button v-if="selected.length" class="btn btn-danger" @click="dropSelected">
        删除选中 {{ selected.length }} 条
      </button>
      <div class="relative export-menu ml-auto">
        <button class="btn btn-ghost" @click="toggleExport">
          导出筛选结果 {{ filtered.length }} 条
          <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div v-if="exportOpen" class="absolute right-0 mt-1.5 w-48 bg-gray-900 border border-gray-800 rounded-lg shadow-lg py-1 z-30">
          <button class="menu-item" @click="pickExport('md')">Markdown<span class="menu-hint">.md</span></button>
          <button class="menu-item" @click="pickExport('csv')">CSV<span class="menu-hint">.csv</span></button>
          <button class="menu-item" @click="pickExport('json')">JSON<span class="menu-hint">.json</span></button>
        </div>
      </div>
    </div>

    <div v-if="loading" class="text-sm text-gray-400 py-10 text-center">加载中…</div>
    <div v-else-if="error" class="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
      加载失败：{{ error }}
      <button class="underline ml-2" @click="load">重试</button>
    </div>
    <div v-else-if="!filtered.length" class="text-sm text-gray-400 py-16 text-center">
      没有选题。用 skill 生成一批，或点右上「新建选题」。
    </div>

    <div v-else class="space-y-3">
      <article v-for="t in pagedList" :key="t.id" class="card-item"
        :class="isSelected(t.id) ? 'is-picked' : ''">
        <div class="flex items-start gap-4">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap mb-1.5">
              <input type="checkbox" class="row-check" :checked="isSelected(t.id)"
                @change="toggleSelect(t.id)" :title="'选中以批量操作'" />
              <span :class="badge('', t.内容定位)">{{ t.内容定位 }}</span>
              <span class="badge badge-path">{{ t.创作路径 }}</span>
              <span v-for="el in (t.爆款元素 || [])" :key="el" class="badge badge-el">{{ el }}</span>
              <span v-for="tag in (t.标签 || [])" :key="tag" class="badge badge-path">#{{ tag }}</span>
            </div>

            <h2 class="text-base font-medium text-gray-100 leading-snug">{{ t.主题 }}</h2>
            <p class="text-sm text-gray-300 mt-1 leading-relaxed">{{ t.看点 }}</p>

            <div v-if="expanded[t.id]" class="mt-3 pl-3 border-l-2 border-gray-800 space-y-1.5">
              <div v-for="(s, i) in (t.结构 || [])" :key="i" class="text-sm">
                <span class="text-gray-400 text-xs mr-2">{{ i + 1 }}</span>
                <span class="font-medium text-gray-200">{{ s.段名 }}</span>
                <span class="text-gray-300">：{{ s.要点 }}</span>
              </div>
              <p v-if="t.备注" class="text-sm text-gray-400 pt-1">备注：{{ t.备注 }}</p>
              <p class="text-xs text-gray-400 pt-1">
                来源：{{ t.来源?.报告 || '—' }}
                <span v-if="t.来源?.话题"> ｜ {{ t.来源.话题 }}</span>
                <span v-if="t.来源?.观众"> ｜ {{ t.来源.观众 }}</span>
              </p>
            </div>

            <button class="text-xs text-gray-400 hover:text-gray-200 mt-2" @click="toggle(t.id)">
              {{ expanded[t.id] ? '收起结构' : '看结构（' + (t.结构 || []).length + ' 段）' }}
            </button>
          </div>

          <div class="flex flex-col items-end gap-2.5 shrink-0">
            <button class="star" :class="t.收藏 ? 'is-on' : ''" @click="toggleFavorite(t)"
              :title="t.收藏 ? '取消收藏' : '收藏'">
              <svg viewBox="0 0 24 24" class="w-5 h-5" :fill="t.收藏 ? 'currentColor' : 'none'"
                stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
                <path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 16.9 6.6 19.8l1-6.1L3.2 9.4l6.1-.9z"/>
              </svg>
            </button>
            <div class="flex gap-1.5">
              <button class="btn btn-ghost" @click="openEdit(t)">编辑</button>
              <button class="btn btn-danger" @click="drop(t)">删除</button>
            </div>
          </div>
        </div>
      </article>
    </div>

    <div v-if="filtered.length" class="flex flex-wrap items-center gap-3 mt-5 pt-4 border-t border-gray-800">
      <span class="text-xs text-gray-400">
        第 {{ rangeFrom }}–{{ rangeTo }} 条，共 {{ filtered.length }} 条
        <span v-if="selected.length" class="text-blue-400 ml-2">已选 {{ selected.length }} 条</span>
      </span>

      <div v-if="totalPages > 1" class="flex items-center gap-1 mx-auto">
        <button class="btn btn-ghost" :class="currentPage === 1 ? 'opacity-40 pointer-events-none' : ''"
          @click="goPage(currentPage - 1)">上一页</button>
        <template v-for="(p, i) in pageItems" :key="i">
          <span v-if="p === '…'" class="px-1.5 text-xs text-gray-400 select-none">…</span>
          <button v-else class="btn min-w-9 justify-center"
            :class="p === currentPage ? 'btn-primary' : 'btn-ghost'"
            @click="goPage(p)">{{ p }}</button>
        </template>
        <button class="btn btn-ghost" :class="currentPage === totalPages ? 'opacity-40 pointer-events-none' : ''"
          @click="goPage(currentPage + 1)">下一页</button>
      </div>

      <label class="text-xs text-gray-400 inline-flex items-center gap-1.5 ml-auto">
        每页
        <select v-model.number="perPage" class="field w-20 py-1 pr-6 text-xs">
          <option :value="20">20</option>
          <option :value="50">50</option>
          <option :value="100">100</option>
          <option :value="0">全部</option>
        </select>
      </label>
    </div>
  </div>

  <div v-if="editing" class="fixed inset-0 z-30 flex justify-end">
    <div class="absolute inset-0 bg-black/60" @click="closeEdit"></div>
    <aside class="relative bg-gray-900 w-full max-w-xl h-full overflow-y-auto shadow-xl">
      <div class="sticky top-0 bg-gray-900 border-b border-gray-800 px-5 py-3 flex items-center">
        <h3 class="text-base font-medium flex-1">{{ editing.id ? '编辑选题' : '新建选题' }}</h3>
        <button class="text-gray-400 hover:text-gray-200 text-xl leading-none" @click="closeEdit">×</button>
      </div>

      <div class="px-5 py-4 space-y-4">
        <div>
          <label class="label">主题（6–30 字）</label>
          <input v-model="editing.主题" class="field" />
          <div class="text-xs mt-1" :class="editing.主题.length > 30 ? 'text-red-400' : 'text-gray-400'">{{ editing.主题.length }} / 30</div>
        </div>

        <div>
          <label class="label">看点（10–90 字）</label>
          <textarea v-model="editing.看点" rows="3" class="field"></textarea>
          <div class="text-xs mt-1" :class="editing.看点.length > 90 ? 'text-red-400' : 'text-gray-400'">{{ editing.看点.length }} / 90</div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label">内容定位</label>
            <select v-model="editing.内容定位" class="field">
              <option v-for="d in 定位们" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>
          <div>
            <label class="label">创作路径</label>
            <select v-model="editing.创作路径" class="field">
              <option v-for="p in 路径们" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
        </div>

        <div>
          <label class="label">爆款元素（1–2 个）</label>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="el in 元素们" :key="el" type="button"
              class="badge border"
              :class="editing.爆款元素.includes(el) ? 'bg-teal-600 text-white border-teal-600' : 'bg-gray-900 text-gray-300 border-gray-700'"
              @click="toggleElement(el)">{{ el }}</button>
          </div>
        </div>

        <div>
          <label class="label">结构（3–5 段）</label>
          <div class="space-y-2">
            <div v-for="(s, i) in editing.结构" :key="i" class="flex gap-2 items-start">
              <div class="w-24 shrink-0">
                <input v-model="s.段名" class="field" placeholder="段名" />
              </div>
              <textarea v-model="s.要点" rows="2" class="field flex-1" placeholder="要点"></textarea>
              <button class="btn btn-danger shrink-0" @click="removeStep(i)" :disabled="editing.结构.length <= 3">删</button>
            </div>
          </div>
          <button class="btn btn-ghost mt-2" @click="addStep" :disabled="editing.结构.length >= 5">+ 加一段</button>
        </div>

        <div>
          <label class="label">标签（逗号分隔）</label>
          <input v-model="editingTags" class="field" placeholder="礼包, 付费, 系列名" />
        </div>

        <div>
          <label class="label">备注</label>
          <textarea v-model="editing.备注" rows="2" class="field" placeholder="拍摄准备、素材缺口…"></textarea>
        </div>

        <div v-if="editing.来源 && editing.来源.报告" class="bg-gray-800 rounded-lg px-3 py-2 text-xs text-gray-400">
          来源报告：{{ editing.来源.报告 }}
          <span v-if="editing.来源.话题"> ｜ {{ editing.来源.话题 }}</span>
          <span v-if="editing.来源.观众"> ｜ {{ editing.来源.观众 }}</span>
        </div>
      </div>

      <div class="sticky bottom-0 bg-gray-900 border-t border-gray-800 px-5 py-3 flex justify-end gap-2">
        <button class="btn btn-ghost" @click="closeEdit">取消</button>
        <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      </div>
    </aside>
  </div>

  <div v-if="showAccount" class="fixed inset-0 z-30 flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-black/60" @click="showAccount = false"></div>
    <div class="relative bg-gray-900 rounded-xl w-full max-w-2xl shadow-xl max-h-[90vh] flex flex-col">
      <div class="px-6 pt-5 pb-4 border-b border-gray-800 flex items-start">
        <div class="flex-1">
          <h3 class="text-base font-medium text-gray-100">账号档案</h3>
          <p class="text-xs text-gray-400 mt-1">选题按这份档案判断人设与转化方向。改完立即生效，下次生成不再追问。</p>
        </div>
        <button class="text-gray-400 hover:text-gray-200 text-xl leading-none px-1" @click="showAccount = false">×</button>
      </div>

      <div class="px-6 py-5 overflow-y-auto space-y-6">
        <section>
          <div class="section-title">基本信息</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="label label-req">赛道</label>
              <input v-model="accountDraft.赛道" class="field" placeholder="游戏 / 效率工具 / 美妆…" />
              <div class="hint">2–30 字，越具体越好</div>
            </div>
            <div>
              <label class="label label-req">目标人群</label>
              <input v-model="accountDraft.目标人群" class="field" placeholder="30+ 有魔兽情结的老玩家" />
              <div class="hint">4–60 字，写清年龄与处境</div>
            </div>
          </div>
        </section>

        <section class="pt-5 border-t border-gray-800">
          <div class="section-title">商业化与背书</div>
          <p class="text-xs text-gray-400 -mt-1 mb-3">留空不影响泛选题；这两项决定人设选题与转化选题从哪来。</p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="label">变现途径</label>
              <input v-model="accountDraft.变现途径文本" class="field" placeholder="带货 / 服务 / 引流" />
              <div class="hint">逗号分隔，最多 5 项</div>
            </div>
            <div>
              <label class="label">专长 / 职业</label>
              <input v-model="accountDraft.专长文本" class="field" placeholder="十年玩家 / 剪辑" />
              <div class="hint">凭什么讲这个，逗号分隔</div>
            </div>
          </div>
        </section>

        <section class="pt-5 border-t border-gray-800">
          <div class="section-title">边界与偏好</div>
          <textarea v-model="accountDraft.补充" rows="3" class="field"
            placeholder="不接纯广告；不做口播；只做横屏…"></textarea>
        </section>
      </div>

      <div class="px-6 py-4 border-t border-gray-800 flex items-center">
        <span class="text-xs flex-1" :class="(accountDraft.赛道 && accountDraft.目标人群) ? 'text-gray-400' : 'text-amber-400'">
          {{ (accountDraft.赛道 && accountDraft.目标人群) ? '必填项已填，可以保存' : '赛道与目标人群为必填' }}
        </span>
        <button class="btn btn-ghost" @click="showAccount = false">取消</button>
        <button class="btn btn-primary ml-2" @click="saveAccount">保存</button>
      </div>
    </div>
  </div>

  <div v-if="deleting" class="fixed inset-0 z-40 flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-black/60" @click="deleting = null"></div>
    <div class="relative bg-gray-900 rounded-xl w-full max-w-md shadow-xl p-5">
      <h3 class="text-base font-medium text-gray-100">删除 {{ deleting.length }} 条选题？</h3>
      <ul class="mt-3 space-y-1 max-h-40 overflow-y-auto">
        <li v-for="t in deleting.slice(0, 6)" :key="t.id" class="text-sm text-gray-300 leading-snug">· {{ t.主题 }}</li>
        <li v-if="deleting.length > 6" class="text-xs text-gray-400">…还有 {{ deleting.length - 6 }} 条</li>
      </ul>
      <p class="text-xs text-red-400 mt-3">直接删除，不可恢复。</p>
      <div class="flex justify-end gap-2 mt-5">
        <button class="btn btn-ghost" @click="deleting = null">取消</button>
        <button class="btn btn-danger" @click="doDrop">删除 {{ deleting.length }} 条</button>
      </div>
    </div>
  </div>

  <div v-if="toast" class="fixed bottom-6 left-1/2 -translate-x-1/2 z-40">
    <div class="px-4 py-2 rounded-lg text-sm text-white shadow-lg"
      :class="toast.kind === 'err' ? 'bg-red-600' : toast.kind === 'warn' ? 'bg-amber-600' : 'bg-gray-800'">
      {{ toast.msg }}
    </div>
  </div>
</div>
`,
}).mount('#app');
