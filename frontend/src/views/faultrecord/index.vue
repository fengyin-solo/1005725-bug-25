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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">明细</button>
            <button
              v-if="nextAction(row)"
              class="link"
              type="button"
              @click="runAction(String(nextAction(row)), row)"
            >
              {{ nextAction(row) }}
            </button>
            <span v-else class="locked-text">已锁定</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无故障录波数据，可先登记录波记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条故障录波记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 明细面板：字段全部取台账行，与列表同一份数据，分析人口径不另起一套。 -->
    <div v-if="detailRow" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>录波明细 {{ detailRow['录波编号'] }}</h3>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <template v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ detailRow[field] || '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detailRow.status }}</dd>
        </dl>

        <form v-if="detailEditable" class="detail-edit" @submit.prevent="saveDetail">
          <h4>分析结论修订（确认定性后锁定）</h4>
          <label>
            <span>故障类型</span>
            <input v-model="editForm['故障类型']" placeholder="如：单相接地" />
          </label>
          <label>
            <span>故障电流</span>
            <input v-model="editForm['故障电流']" placeholder="如：3.95kA" />
          </label>
          <label>
            <span>分析人</span>
            <input v-model="editForm['分析人']" />
          </label>
          <label class="edit-conclusion">
            <span>分析结论</span>
            <textarea v-model="editForm['分析结论']" rows="3"></textarea>
          </label>
          <div class="drawer-actions">
            <button class="btn primary" type="submit">保存结论</button>
            <span v-if="detailMessage" class="form-message" :class="{ ok: detailOk }">{{ detailMessage }}</span>
          </div>
        </form>
        <p v-else class="detail-lock">
          当前「{{ detailRow.status }}」状态下分析结论已锁定，如需修改请在分析中阶段完成。
        </p>
      </aside>
    </div>

    <!-- 登记表单：同一录波编号重复提交直接挡回，不再新增第二行。 -->
    <div v-if="creating" class="drawer-mask" @click.self="creating = false">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>登记录波记录</h3>
          <button class="link" type="button" @click="creating = false">关闭</button>
        </header>
        <form class="detail-edit" @submit.prevent="submitCreate">
          <label>
            <span>录波编号</span>
            <input v-model="createForm['录波编号']" placeholder="如：FAUL-202610-003" />
          </label>
          <label>
            <span>故障线路</span>
            <input v-model="createForm['故障线路']" placeholder="如：110kV 云港线" />
          </label>
          <label>
            <span>故障类型</span>
            <input v-model="createForm['故障类型']" placeholder="可留待分析时补充" />
          </label>
          <label>
            <span>故障电流</span>
            <input v-model="createForm['故障电流']" placeholder="可留待分析时补充" />
          </label>
          <label>
            <span>故障时间</span>
            <input v-model="createForm['故障时间']" placeholder="留空取当前时间" />
          </label>
          <div class="drawer-actions">
            <button class="btn primary" type="submit">提交登记</button>
            <span v-if="createMessage" class="form-message" :class="{ ok: createOk }">{{ createMessage }}</span>
          </div>
        </form>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createEntry,
  downloadEntries,
  getEntry,
  listEntries,
  metricValues,
  moduleMeta,
  runAction as applyAction,
  updateEntryFields,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, MetricValue } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('faultrecord')
const columns = ["录波编号", "故障线路", "故障类型", "故障电流", "故障时间", "分析人", "分析结论", "录波状态"]
const actions = ["提交分析", "确认定性", "归档录波"]
const statuses = ["待分析", "分析中", "已定性", "已归档"]
const detailFields = [...columns, '归档时间']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const stats = ref<MetricValue[]>(metricValues(meta.key).map((item) => ({ ...item })))

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key, filters.value)
}

// 严格逐级：每行只给出当前状态的下一档动作，已归档无动作（不可回退改结论）。
function nextAction(row: EntryRow): string | null {
  const index = statuses.indexOf(String(row.status))
  if (index < 0 || index >= actions.length) {
    return null
  }
  return actions[index]
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, store.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  syncDetail(Number(row.id))
}

const creating = ref(false)
const createForm = reactive<Record<string, string>>({
  '录波编号': '',
  '故障线路': '',
  '故障类型': '',
  '故障电流': '',
  '故障时间': '',
})
const createMessage = ref('')
const createOk = ref(false)

function openCreate() {
  for (const field of Object.keys(createForm)) {
    createForm[field] = ''
  }
  createMessage.value = ''
  createOk.value = false
  creating.value = true
}

function submitCreate() {
  createMessage.value = ''
  const fields: Record<string, string> = {}
  for (const [field, value] of Object.entries(createForm)) {
    if (value.trim()) {
      fields[field] = value.trim()
    }
  }
  const result = createEntry(meta.key, { fields })
  createOk.value = result.ok
  createMessage.value = result.message
  if (!result.ok) {
    return
  }
  creating.value = false
  reload()
}

const detailId = ref<number | null>(null)
const detailRow = ref<EntryRow | null>(null)
const editForm = reactive<Record<string, string>>({
  '故障类型': '',
  '故障电流': '',
  '分析人': '',
  '分析结论': '',
})
const detailMessage = ref('')
const detailOk = ref(false)

const detailEditable = computed(() => detailRow.value?.status === '分析中')

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
  syncDetail(detailId.value)
}

function syncDetail(id: number) {
  const latest = getEntry(meta.key, id)
  if (!latest) {
    closeDetail()
    return
  }
  detailRow.value = { ...latest }
  for (const field of Object.keys(editForm)) {
    editForm[field] = String(latest[field] ?? '')
  }
  detailMessage.value = ''
  detailOk.value = false
}

function closeDetail() {
  detailId.value = null
  detailRow.value = null
}

function saveDetail() {
  if (detailId.value === null) {
    return
  }
  detailMessage.value = ''
  const result = updateEntryFields(
    meta.key,
    detailId.value,
    { fields: { ...editForm } },
    {
      allowedStatuses: ['分析中'],
      editableFields: ['故障类型', '故障电流', '分析人', '分析结论'],
    },
  )
  detailOk.value = result.ok
  detailMessage.value = result.message
  if (!result.ok) {
    return
  }
  reload()
  syncDetail(detailId.value)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = metricValues(meta.key)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '故障录波列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 20;
}
.drawer {
  width: 460px;
  max-width: 92vw;
  height: 100%;
  background: #fff;
  padding: 18px 20px;
  overflow-y: auto;
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.drawer-head h3 { margin: 0; font-size: 16px; }
.detail-grid {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 6px 12px;
  margin: 0 0 16px;
  font-size: 13px;
}
.detail-grid dt { color: var(--muted); }
.detail-grid dd { margin: 0; word-break: break-all; }
.detail-edit h4 { margin: 12px 0 8px; font-size: 14px; }
.detail-edit label { display: block; margin-bottom: 8px; font-size: 12px; color: var(--muted); }
.detail-edit input,
.detail-edit textarea {
  width: 100%;
  margin-top: 2px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  color: #1f2937;
}
.edit-conclusion textarea { resize: vertical; }
.drawer-actions { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.form-message { font-size: 12px; color: #b42318; }
.form-message.ok { color: #157347; }
.detail-lock { font-size: 12px; color: var(--muted); background: #eef2f7; padding: 8px 10px; border-radius: 6px; }
.locked-text { color: var(--muted); font-size: 12px; }
</style>
