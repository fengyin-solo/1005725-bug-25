import { MODULE_BY_KEY } from '@/data/modules'
import { listRows, nextId, resetRows, saveMany, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryDraft,
  EntryPatch,
  EntryRow,
  MetricValue,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 严格逐级流转的模块：状态只能按 statuses 顺序一档一档往前走，越级一律挡回。
const STRICT_LINEAR_KEYS = new Set(['faultrecord'])

const FAULT_KEY = 'faultrecord'
const TRIP_KEY = 'tripstat'
const ARCHIVED_STATUS = '已归档'
const PENDING_TRIP_STATUS = '待统计'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function formatNow(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} `
    + `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
}

function monthToken(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`
}

// 取行内日期字段所属月份，兼容 'YYYY-MM-DD HH:mm:ss' 与 'YYYY-MM-DD'。
function monthOf(row: EntryRow, field: string): string {
  const raw = String(row[field] ?? '').trim()
  return /^\d{4}-\d{2}/.test(raw) ? raw.slice(0, 7) : ''
}

function statusMirrorField(meta: ModuleMeta): string | undefined {
  // 台账里常有一列与工作流状态同名口径（如「录波状态」），流转时一并同步，两处不再打架。
  return meta.fields.find((field) => field.endsWith('状态'))
}

function syncStatusMirror(row: EntryRow, meta: ModuleMeta, target: string): EntryRow {
  const mirror = statusMirrorField(meta)
  return mirror ? { ...row, [mirror]: target } : { ...row }
}

export function runAction(key: string, id: number, action: string, operator = ''): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  const targetIndex = meta.statuses.indexOf(target)
  const currentIndex = meta.statuses.indexOf(current)

  if (current === target) {
    // 终态重复提交按幂等处理：不再新增、不再回写，重条自然进不来。
    return { ok: true, message: `${meta.entity}已经是「${target}」，未重复处理` }
  }

  if (STRICT_LINEAR_KEYS.has(key)) {
    if (targetIndex < currentIndex) {
      return {
        ok: false,
        message: `录波记录当前为「${current}」，已归档/已定性结论不允许退回「${target}」修改`,
      }
    }
    if (targetIndex !== currentIndex + 1) {
      return {
        ok: false,
        message: `录波记录当前为「${current}」，不能越级到「${target}」，请先完成「${meta.statuses[currentIndex + 1]}」`,
      }
    }
  }

  const now = new Date()
  let updated: EntryRow = { ...rows[index], status: target }
  updated = syncStatusMirror(updated, meta, target)
  updated = applyActionPatch(key, action, updated, { now: formatNow(now), operator })
  updated = {
    ...updated,
    pending: STRICT_LINEAR_KEYS.has(key)
      ? target !== meta.statuses[meta.statuses.length - 1]
      : updated.pending,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }

  const next = [...rows]
  next[index] = updated

  // 录波归档：分析结论随归档一并落到保护动作统计的「待统计」清单，两侧一次落库。
  const sidePatch = key === FAULT_KEY && action === '归档录波'
    ? archiveTripSideEffect(updated, now)
    : {}
  saveMany({ [key]: next, ...sidePatch })
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

type ActionContext = { now: string; operator: string }

// 动作触发的台账字段补录：提交动作把当前操作人落到台账的「…人」字段，归档落归档时间。
function applyActionPatch(key: string, action: string, row: EntryRow, ctx: ActionContext): EntryRow {
  if (key === FAULT_KEY) {
    if (action === '提交分析' && ctx.operator && !String(row['分析人'] ?? '').trim()) {
      return { ...row, '分析人': ctx.operator }
    }
    if (action === '归档录波') {
      return { ...row, '归档时间': ctx.now }
    }
    return row
  }
  if (key === TRIP_KEY && action === '提交统计' && ctx.operator
    && !String(row['统计人'] ?? '').trim()) {
    return { ...row, '统计人': ctx.operator }
  }
  return row
}

// 归档联动保护动作统计：按「来源录波」幂等 upsert，只补还在「待统计」的单子；
// 统计员已经接手（统计中/已汇总/已复核）的单子不回写，避免覆盖人工统计结果。
function archiveTripSideEffect(row: EntryRow, now: Date): Record<string, EntryRow[]> {
  const tripRows = listRows(TRIP_KEY)
  const code = String(row['录波编号'] ?? '').trim()
  const month = monthOf(row, '归档时间') || monthOf(row, '故障时间') || monthToken(now)
  const existingIndex = tripRows.findIndex((item) => String(item['来源录波'] ?? '') === code)

  if (existingIndex >= 0) {
    const existing = tripRows[existingIndex]
    if (String(existing.status) !== PENDING_TRIP_STATUS) {
      return {}
    }
    const refreshed = {
      ...existing,
      '所属线路': row['故障线路'],
      '故障类型': row['故障类型'],
      '分析结论': row['分析结论'],
      '统计月份': month,
    }
    const next = [...tripRows]
    next[existingIndex] = refreshed
    return { [TRIP_KEY]: next }
  }

  const seq = tripRows.filter((item) => String(item['统计月份'] ?? '') === month).length + 1
  const created: EntryRow = {
    id: nextId(TRIP_KEY),
    status: PENDING_TRIP_STATUS,
    pending: true,
    abnormal: false,
    '统计编号': `TRIP-${month}-${String(seq).padStart(3, '0')}`,
    '所属线路': row['故障线路'],
    '动作次数': '1',
    '正确动作次数': '',
    '误动次数': '',
    '统计月份': month,
    '统计人': '',
    '统计状态': PENDING_TRIP_STATUS,
    '来源录波': code,
    '故障类型': row['故障类型'],
    '分析结论': row['分析结论'],
  }
  return { [TRIP_KEY]: [...tripRows, created] }
}

// 登记新录波（及其它台账）：同业务键重复提交直接挡回，只保留最早那条，列表不会再多一行。
export function createEntry(key: string, draft: EntryDraft): ActionResult {
  const meta = moduleMeta(key)
  const identity = meta.fields[0]
  const code = String(draft.fields[identity] ?? '').trim()
  if (!code) {
    return { ok: false, message: `请先填写${identity}` }
  }
  const rows = listRows(key)
  const existing = rows.find((row) => String(row[identity] ?? '').trim() === code)
  if (existing) {
    return {
      ok: false,
      message: `${identity} ${code} 已存在（#${existing.id}，当前「${existing.status}」），重复提交未新增记录`,
    }
  }

  const firstStatus = meta.statuses[0]
  const now = new Date()
  let created: EntryRow = {
    id: nextId(key),
    status: firstStatus,
    pending: true,
    abnormal: false,
    ...draft.fields,
    [identity]: code,
  }
  if (key === FAULT_KEY && !String(created['故障时间'] ?? '').trim()) {
    created['故障时间'] = formatNow(now)
  }
  created = syncStatusMirror(created, meta, firstStatus)
  saveRows(key, [...rows, created])
  return { ok: true, message: `${meta.entity} ${code} 已登记，当前状态「${firstStatus}」` }
}

// 明细面板修订台账字段：名单与明细共用这同一份数据，改一处两边一致。
export function updateEntryFields(
  key: string,
  id: number,
  patch: EntryPatch,
  options: { allowedStatuses?: string[]; editableFields?: string[] } = {},
): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = rows[index]
  if (options.allowedStatuses && !options.allowedStatuses.includes(String(current.status))) {
    return {
      ok: false,
      message: `${meta.entity}当前为「${current.status}」，分析结论已锁定，不能再修改`,
    }
  }
  const allowed = options.editableFields
  const nextFields: Record<string, string> = {}
  for (const [field, value] of Object.entries(patch.fields)) {
    if (allowed && !allowed.includes(field)) {
      continue
    }
    nextFields[field] = value
  }
  const updated = { ...current, ...nextFields }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: '台账已更新' }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 导出与页面列表同一口径：同样的台账列、同样的筛选结果、同样的去重结果，
// 另在末尾补「当前状态」工作流状态列。
export function exportEntries(
  key: string,
  filters: Record<string, string> = {},
): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = [...meta.fields, '当前状态']
  const rows = filterRows(listRows(key), filters)
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    const cells = [...meta.fields.map((field) => row[field] ?? ''), row.status]
    lines.push(cells.map(csvCell).join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string, filters: Record<string, string> = {}): void {
  const { filename, content } = exportEntries(key, filters)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function toNumber(value: unknown): number {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

// 「本月…」类指标的取数规则：状态 + 完成日期所在月份，或月度字段求和。
const MONTH_METRIC_RULES: Record<string, Record<string, (rows: EntryRow[], month: string) => number>> = {
  faultrecord: {
    本月归档数: (rows, month) =>
      rows.filter((row) => {
        if (String(row.status) !== ARCHIVED_STATUS) {
          return false
        }
        const stamped = monthOf(row, '归档时间')
        return (stamped || monthOf(row, '故障时间')) === month
      }).length,
  },
  tripstat: {
    本月误动次数: (rows, month) =>
      rows
        .filter((row) => String(row['统计月份'] ?? '') === month)
        .reduce((sum, row) => sum + toNumber(row['误动次数']), 0),
  },
  transformermaint: {
    本月完工数: (rows, month) =>
      rows.filter((row) => String(row.status) === '已完工' && monthOf(row, '完成日期') === month).length,
  },
  defect: {
    本月消除数: (rows, month) =>
      rows.filter((row) => String(row.status) === '已消除' && monthOf(row, '处理期限') === month).length,
  },
  patrol: {
    本月发现问题数: (rows, month) =>
      rows
        .filter((row) => monthOf(row, '巡视日期') === month)
        .reduce((sum, row) => sum + toNumber(row['发现缺陷数']), 0),
  },
  settingapprove: {
    本月批准数: (rows, month) =>
      rows.filter((row) => String(row.status) === '已批准' && monthOf(row, '送审日期') === month).length,
  },
}

// 模块指标实时取数：状态类指标按当前状态计数，本月类指标按上面的月度规则，
// 页面不再写死 0，归档完成当月归档数立即跟着动。
export function metricValues(key: string, now: Date = new Date()): MetricValue[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const month = monthToken(now)
  const monthRules = MONTH_METRIC_RULES[key] ?? {}
  return meta.metrics.map((label) => {
    const status = meta.statuses.find((item) => label.includes(item))
    if (status) {
      return { label, value: rows.filter((row) => String(row.status) === status).length }
    }
    const rule = monthRules[label]
    return { label, value: rule ? rule(rows, month) : 0 }
  })
}

export function loadOverview(): OverviewResult {
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = listRows(meta.key)
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
      metrics: metricValues(meta.key),
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
