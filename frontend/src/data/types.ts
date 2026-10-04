/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

/** 登记新记录时的入参：编号、状态、标记由数据层统一补齐。 */
export type EntryDraft = {
  fields: Record<string, string>
}

/** 台账内字段的局部修订，只允许改业务字段，状态走动作流转。 */
export type EntryPatch = {
  fields: Record<string, string>
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type MetricValue = {
  label: string
  value: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: {
    name: string
    created: number
    pending: number
    abnormal: number
    metrics: MetricValue[]
  }[]
}
