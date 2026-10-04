import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveModules, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 故障录波归档的专门口径：录波台账是唯一数据源，归档时把结论一并推进保护动作统计的待统计清单。
const FAULT_RECORD_KEY = 'faultrecord'
const TRIP_STAT_KEY = 'tripstat'
const SOURCE_RECORD_FIELD = '来源录波编号'

// 列表、导出、明细都去重后的同一份数据：同一业务编号只留最早那条（id 最小）。
const DEDUPE_FIELD_BY_MODULE: Record<string, string> = {
  [FAULT_RECORD_KEY]: '录波编号',
  [TRIP_STAT_KEY]: SOURCE_RECORD_FIELD,
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

// 月份口径：getMonth() 从 0 开始，必须 +1，否则统计月份会串到上一个月。
export function currentMonthLabel(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
}

export function todayLabel(date: Date = new Date()): string {
  return `${currentMonthLabel(date)}-${pad2(date.getDate())}`
}

function dedupeKeepEarliest(rows: EntryRow[], field: string): EntryRow[] {
  const earliestId = new Map<string, number>()
  for (const row of rows) {
    const key = String(row[field] ?? '').trim()
    if (!key) {
      continue
    }
    const id = Number(row.id)
    const prev = earliestId.get(key)
    if (prev === undefined || id < prev) {
      earliestId.set(key, id)
    }
  }
  return rows.filter((row) => {
    const key = String(row[field] ?? '').trim()
    if (!key) {
      return true
    }
    return Number(row.id) === earliestId.get(key)
  })
}

// 读出口径统一走这里：发现历史重条就当场清掉并落库，之后列表、导出、明细看到的都是同一份。
function normalizedRows(key: string): EntryRow[] {
  const rows = listRows(key)
  const field = DEDUPE_FIELD_BY_MODULE[key]
  if (!field) {
    return rows
  }
  const deduped = dedupeKeepEarliest(rows, field)
  if (deduped.length !== rows.length) {
    saveRows(key, deduped)
  }
  return deduped
}

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
  const matched = filterRows(normalizedRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string, operator = ''): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = normalizedRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (meta.enforceOrder) {
    const from = meta.statuses.indexOf(current)
    const to = meta.statuses.indexOf(target)
    if (from >= 0 && to >= 0) {
      if (to < from) {
        return { ok: false, message: `${meta.entity}已到「${current}」，不许回退到「${target}」改结论` }
      }
      if (to > from + 1) {
        return { ok: false, message: `${meta.entity}还在「${current}」，不能越级到「${target}」，请先完成前一步` }
      }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (key === FAULT_RECORD_KEY) {
    return applyFaultRecordTransition(meta, rows, index, updated, action, operator)
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 故障录波的流转只改这一条记录本身：分析结论、故障类型、故障电流始终走台账里同一份数据。
function applyFaultRecordTransition(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
  updated: EntryRow,
  action: string,
  operator: string,
): ActionResult {
  const record: EntryRow = { ...updated, 录波状态: updated.status }
  if (action === '提交分析' && operator) {
    // 由哪个人分析的，就落在这一条上，名单与明细看的是同一份。
    record['分析人'] = operator
  }
  if (action !== '归档录波') {
    const next = [...rows]
    next[index] = record
    saveRows(FAULT_RECORD_KEY, next)
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${record.status}」` }
  }
  // 归档：打上归档时间，录波台账与保护动作统计的待统计清单一并一次落库。
  record['归档时间'] = todayLabel()
  const nextRecords = [...rows]
  nextRecords[index] = record
  const tripRows = normalizedRows(TRIP_STAT_KEY)
  const recordCode = String(record['录波编号'] ?? '')
  const alreadyQueued = tripRows.some(
    (row) => String(row[SOURCE_RECORD_FIELD] ?? '') === recordCode && recordCode !== '',
  )
  const nextTripRows = alreadyQueued ? tripRows : [...tripRows, buildTripStatRow(record, tripRows)]
  saveModules({ [FAULT_RECORD_KEY]: nextRecords, [TRIP_STAT_KEY]: nextTripRows })
  const message = alreadyQueued
    ? `${meta.entity}已归档，待统计清单里已有这份录波，未重复登记`
    : `${meta.entity}已归档，结论已送入保护动作统计待统计清单`
  return { ok: true, message }
}

function buildTripStatRow(record: EntryRow, existing: EntryRow[]): EntryRow {
  const nextId = existing.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  return {
    id: nextId,
    status: '待统计',
    pending: true,
    abnormal: false,
    统计编号: `TRIP-${String(nextId).padStart(4, '0')}`,
    所属线路: record['故障线路'] ?? '',
    动作次数: 0,
    正确动作次数: 0,
    误动次数: 0,
    统计月份: currentMonthLabel(),
    统计人: '',
    统计状态: '待统计',
    [SOURCE_RECORD_FIELD]: record['录波编号'] ?? '',
  }
}

// 录波概览口径：本月归档数按归档时间落在本月（含本月）的已归档记录统计。
export function faultRecordMetrics(): { label: string; value: number }[] {
  const rows = normalizedRows(FAULT_RECORD_KEY)
  const thisMonth = currentMonthLabel()
  return [
    { label: '待分析录波', value: rows.filter((row) => row.status === '待分析').length },
    { label: '分析中录波', value: rows.filter((row) => row.status === '分析中').length },
    {
      label: '本月归档数',
      value: rows.filter(
        (row) => row.status === '已归档' && String(row['归档时间'] ?? '').startsWith(thisMonth),
      ).length,
    },
  ]
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of normalizedRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
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

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
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
