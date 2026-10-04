/* 归档流程的行为验证：在 node 里跑一遍录波流转，确认台账、去重、越级挡回、待统计清单的口径。 */
import {
  exportEntries,
  faultRecordMetrics,
  listEntries,
  runAction,
} from '@/api/local-service'
import { listRows, resetRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`ok  - ${name}`)
  } else {
    failures += 1
    console.log(`FAIL- ${name}`, extra ?? '')
  }
}

// 清到种子数据再开始
resetRows('faultrecord')
resetRows('tripstat')

// ---- 1. 逐级流转 + 分析人落账 ----
let r = runAction('faultrecord', 1, '提交分析', '张三')
check('提交分析成功', r.ok, r.message)
let row = listRows('faultrecord').find((x) => x.id === 1) as EntryRow
check('分析人落在台账这一条上', row['分析人'] === '张三', row['分析人'])
check('录波状态字段与状态同步', row['录波状态'] === '分析中', row['录波状态'])
check('结论/类型/电流仍在', Boolean(row['分析结论'] && row['故障类型'] && row['故障电流']))

// ---- 2. 越级挡回：分析中不能直接归档 ----
r = runAction('faultrecord', 1, '归档录波', '张三')
check('越级归档被挡回', !r.ok && r.message.includes('越级'), r.message)

// ---- 3. 确认定性后归档：一次落库，联动待统计清单 ----
runAction('faultrecord', 1, '确认定性', '张三')
r = runAction('faultrecord', 1, '归档录波', '张三')
check('归档成功', r.ok, r.message)
row = listRows('faultrecord').find((x) => x.id === 1) as EntryRow
check('归档后状态', row.status === '已归档' && row['录波状态'] === '已归档')
check('归档时间已写入且是本月', String(row['归档时间']).startsWith('2026-10'), row['归档时间'])
check('归档后结论与电流没丢', Boolean(row['分析结论'] && row['故障电流'] && row['故障类型']))
check('归档后不再 pending', row.pending === false)

const trips = listRows('tripstat')
const queued = trips.filter((x) => String(x['来源录波编号']) === 'FAUL-0001')
check('待统计清单新增一条且只一条', queued.length === 1, queued.length)
check('待统计清单状态为待统计', queued[0]?.status === '待统计' && queued[0]?.pending === true)
check('所属线路沿用故障线路', queued[0]?.['所属线路'] === row['故障线路'], queued[0]?.['所属线路'])
check('统计月份是本月不是上月', queued[0]?.['统计月份'] === '2026-10', queued[0]?.['统计月份'])

// ---- 4. 重复归档：不出重条 ----
r = runAction('faultrecord', 1, '归档录波', '张三')
check('重复归档被挡回', !r.ok, r.message)
check('录波列表没有重条', listRows('faultrecord').filter((x) => x['录波编号'] === 'FAUL-0001').length === 1)
check('待统计清单没有重条', listRows('tripstat').filter((x) => String(x['来源录波编号']) === 'FAUL-0001').length === 1)

// ---- 5. 已归档不许回退改结论 ----
r = runAction('faultrecord', 1, '提交分析', '李四')
check('已归档回退被挡回', !r.ok && r.message.includes('不许回退'), r.message)
row = listRows('faultrecord').find((x) => x.id === 1) as EntryRow
check('分析人没被改掉', row['分析人'] === '张三', row['分析人'])
check('状态仍是已归档', row.status === '已归档')

// ---- 6. 概览口径：本月归档数 ----
const metrics = faultRecordMetrics()
const archived = metrics.find((m) => m.label === '本月归档数')
check('本月归档数 = 1', archived?.value === 1, metrics)

// ---- 7. 历史重条清理：只留最早那条，列表与导出一致 ----
const fr = listRows('faultrecord')
const dup: EntryRow = { ...fr[0], id: 99, status: '已定性', 分析结论: '重条结论' }
// 直接塞一条重条进存储，模拟历史脏数据
saveRows('faultrecord', [...fr, dup])
const listed = listEntries('faultrecord')
check('列表里重条被清掉', listed.items.filter((x) => x['录波编号'] === 'FAUL-0001').length === 1)
check('留下的是最早那条(id=1)', listed.items.find((x) => x['录波编号'] === 'FAUL-0001')?.id === 1)
check('结论还是最早那条的', listed.items.find((x) => x['录波编号'] === 'FAUL-0001')?.['分析结论'] !== '重条结论')
const csv = exportEntries('faultrecord')
check('导出清单与列表同一份', csv.content.split('\n').length - 1 === listed.total, [csv.content.split('\n').length - 1, listed.total])
check('存储里的重条也被清掉', listRows('faultrecord').filter((x) => x['录波编号'] === 'FAUL-0001').length === 1)

// ---- 8. 另一条录波完整走一遍，待统计清单按录波编号各自一条 ----
runAction('faultrecord', 2, '提交分析', '王五')
runAction('faultrecord', 2, '确认定性', '王五')
runAction('faultrecord', 2, '归档录波', '王五')
const trips2 = listRows('tripstat').filter((x) => String(x['来源录波编号'] ?? '') !== '')
check('两条归档各进一条待统计', trips2.length === 2, trips2.length)
check('本月归档数 = 2', faultRecordMetrics().find((m) => m.label === '本月归档数')?.value === 2)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
