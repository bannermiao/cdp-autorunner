/* global Vue */

const { createApp, ref, computed, onMounted } = Vue;

createApp({
  setup() {
    const items = ref([]);
    const loading = ref(true);
    const live = ref(false);
    const filter = ref('all');
    const picked = ref([]);
    const playing = ref(null);
    const reportText = ref('');
    const copied = ref(false);
    const root = ref('');

    const shown = computed(() =>
      filter.value === 'fav' ? items.value.filter((x) => x.fav) : items.value);
    const favCount = computed(() => items.value.filter((x) => x.fav).length);

    function fmtNum(n) {
      if (n === null || n === undefined) return '-';
      if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
      if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
      return String(n);
    }

    function fmtDur(sec) {
      if (!sec) return '-';
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      const pad = (v) => String(v).padStart(2, '0');
      return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    async function load() {
      try {
        const r = await fetch('/api/library');
        const j = await r.json();
        items.value = j.items || [];
        root.value = j.root || '';
      } finally {
        loading.value = false;
      }
    }

    function connect() {
      const es = new EventSource('/api/events');
      es.onopen = () => { live.value = true; };
      es.onerror = () => { live.value = false; };
      es.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'snapshot' && Array.isArray(msg.items)) {
          items.value = msg.items;
        } else if (msg.type === 'new' && msg.item) {
          if (!items.value.some((x) => x.id === msg.item.id)) items.value.unshift(msg.item);
        } else if (msg.type === 'update' && msg.item) {
          const i = items.value.findIndex((x) => x.id === msg.item.id);
          if (i >= 0) items.value[i] = { ...items.value[i], ...msg.item };
        }
      };
    }

    function toggle(id) {
      picked.value = picked.value.includes(id)
        ? picked.value.filter((x) => x !== id)
        : [...picked.value, id];
    }

    function selectAll() {
      picked.value = shown.value.map((x) => x.id);
    }

    function clearSel() {
      picked.value = [];
    }

    async function fav(it) {
      const next = !it.fav;
      it.fav = next;
      try {
        await fetch(`/api/item/${it.id}/fav`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fav: next }),
        });
      } catch { it.fav = !next; }
    }

    async function del(it) {
      items.value = items.value.filter((x) => x.id !== it.id);
      picked.value = picked.value.filter((x) => x !== it.id);
      try {
        await fetch(`/api/item/${it.id}/delete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deleted: true }),
        });
      } catch { load(); }
    }

    async function bulkDelete() {
      const ids = [...picked.value];
      picked.value = [];
      items.value = items.value.filter((x) => !ids.includes(x.id));
      await Promise.all(ids.map((id) =>
        fetch(`/api/item/${id}/delete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deleted: true }),
        }).catch(() => {})));
    }

    function report() {
      const ids = [...picked.value];
      if (!ids.length) return;
      reportText.value = `将 ${root.value} 下的 ${ids.join('、')} 视频用 douyin-viral-blueprint 技能生成报告`;
      copied.value = false;
    }

    async function copy() {
      const text = reportText.value;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      copied.value = true;
      setTimeout(() => { copied.value = false; }, 1500);
    }

    function play(it) { playing.value = it; }
    function closePlay() { playing.value = null; }

    onMounted(() => {
      load();
      connect();
    });

    return {
      items, loading, live, filter, picked, playing, reportText, copied, root,
      shown, favCount,
      fmtNum, fmtDur, toggle, selectAll, clearSel, fav, del, bulkDelete, report, copy,
      play, closePlay,
    };
  },
}).mount('#app');
