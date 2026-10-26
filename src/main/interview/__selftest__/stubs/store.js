// 内存版 JsonCollection 桩：替代 src/main/store/store
const stores = new Map()
class JsonCollection {
  constructor(file, fallback = []) {
    this.file = file
    if (!stores.has(file)) stores.set(file, JSON.parse(JSON.stringify(fallback)))
    this.items = stores.get(file)
  }
  all() { return this.items }
  get(id) { return this.items.find((i) => i.id === id) ?? null }
  upsert(item) {
    const i = this.items.findIndex((x) => x.id === item.id)
    if (i >= 0) this.items[i] = item
    else this.items.unshift(item)
    return item
  }
  patch(id, patch) {
    const i = this.items.findIndex((x) => x.id === id)
    if (i < 0) return null
    this.items[i] = { ...this.items[i], ...patch }
    return this.items[i]
  }
  remove(id) {
    const i = this.items.findIndex((x) => x.id === id)
    if (i >= 0) this.items.splice(i, 1)
  }
}
function dataFile(name) { return name }
module.exports = { JsonCollection, dataFile, __stores: stores }
