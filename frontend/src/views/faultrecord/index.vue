<template>
  <section class="page" data-module="faultrecord">
    <header class="page-head">
      <div>
        <h2>故障录波管理</h2>
        <p class="page-desc">维护录波记录，围绕录波编号、故障线路、故障类型、故障电流做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记录波记录</button>
        <button class="btn" type="button" @click="exportRows">导出故障录波清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :class="{ 'row-selected': selected && Number(selected.id) === Number(row.id) }"
          @click="selectRow(row)"
        >
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click.stop="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无故障录波数据，可先登记录波记录</td>
        </tr>
      </tbody>
    </table>

    <aside v-if="selected" class="detail-panel">
      <header class="detail-head">
        <h3>录波明细 · {{ selected['录波编号'] }}</h3>
        <button class="btn ghost" type="button" @click="selectedId = null">收起</button>
      </header>
      <dl class="detail-grid">
        <div v-for="field in detailFields" :key="field" class="detail-item">
          <dt>{{ field }}</dt>
          <dd>{{ selected[field] ?? '—' }}</dd>
        </div>
        <div class="detail-item">
          <dt>当前状态</dt>
          <dd>{{ selected.status }}</dd>
        </div>
      </dl>
    </aside>

    <footer class="page-foot">
      <span>共 {{ total }} 条故障录波记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  faultRecordMetrics,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('faultrecord')
const columns = ["录波编号", "故障线路", "故障类型", "故障电流", "故障时间", "分析人", "分析结论", "录波状态"]
const actions = ["提交分析", "确认定性", "归档录波"]
const statuses = ["待分析", "分析中", "已定性", "已归档"]
const detailFields = [...columns, "归档时间"]

const session = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const selectedId = ref<number | null>(null)
const stats = ref<{ label: string; value: number }[]>([])
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 明细面板与录波名单读的是同一份台账数据，分析人等字段两边天然一致。
const selected = computed(
  () => rows.value.find((row) => Number(row.id) === selectedId.value) ?? null,
)

function selectRow(row: EntryRow) {
  selectedId.value = Number(row.id)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '录波记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, session.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = faultRecordMetrics()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '故障录波列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.data-table tbody tr {
  cursor: pointer;
}
.row-selected td {
  background: #eef4ff;
}
.detail-panel {
  margin-top: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.detail-head h3 {
  margin: 0;
  font-size: 14px;
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px 16px;
  margin: 12px 0 0;
}
.detail-item dt {
  color: var(--muted);
  font-size: 12px;
}
.detail-item dd {
  margin: 2px 0 0;
  font-size: 13px;
}
</style>
