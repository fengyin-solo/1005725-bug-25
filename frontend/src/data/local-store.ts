import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'substation-protection:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 重条只留最早那条：同一业务键（各模块台账的首列，如录波编号、统计编号）出现多行时，
// 以编号最小的一条为准，后来的重复提交整行丢弃，避免列表、导出、概览三处口径不一致。
function dedupeRows(key: string, rows: EntryRow[]): EntryRow[] {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta || meta.fields.length === 0) {
    return rows
  }
  const identity = meta.fields[0]
  const winners = new Map<string, EntryRow>()
  for (const row of rows) {
    const code = String(row[identity] ?? '').trim()
    if (!code) {
      // 没有业务键的异常行不参与合并，原样保留以免静默丢数据。
      const placeholder = `__nokey__:${row.id}`
      winners.set(placeholder, row)
      continue
    }
    const existing = winners.get(code)
    if (!existing || Number(row.id) < Number(existing.id)) {
      winners.set(code, row)
    }
  }
  return [...winners.values()].sort((a, b) => Number(a.id) - Number(b.id))
}

function normalize(raw: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const normalized: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(raw)) {
    if (!MODULE_BY_KEY.has(key)) {
      continue
    }
    normalized[key] = dedupeRows(key, raw[key] ?? [])
  }
  return normalized
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = normalize(clone(SEED_ROWS))
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 以种子模块为底，合并浏览器里已有改动；历史脏数据在这里一并去重。
    const merged: Record<string, EntryRow[]> = { ...clone(SEED_ROWS), ...parsed }
    return normalize(merged)
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

function persist(next: Record<string, EntryRow[]>): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  persist({ ...allRows(), [key]: rows })
}

// 跨模块联动（如录波归档同时写保护动作统计）走一次落库，
// 调用方拿到结果时两侧数据必然同时生效，不会只写一半。
export function saveMany(patch: Record<string, EntryRow[]>): void {
  persist({ ...allRows(), ...patch })
}

export function nextId(key: string): number {
  const rows = listRows(key)
  return rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
}

export function resetRows(key: string): EntryRow[] {
  const rows = dedupeRows(key, clone(SEED_ROWS[key] ?? []))
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
