interface Options {
  maxItems: number
}

type Generator<T> = () => Promise<T>

type ItemCallback<T> = (item: T) => void

export class Scheduler<T> {
  private ready: T[] = []
  private active: { [id: string]: T } = {}
  private waiting: ItemCallback<T>[] = []

  constructor(private _generator: Generator<T>, private _options: Options) {}

  public async getNext(id: string): Promise<T> {
    const readyCount = this.ready.length
    const activeCount = Object.values(this.active).length
    const totalCount = readyCount + activeCount

    if (readyCount) {
      const nextItem = this.ready.pop()!
      this.active[id] = nextItem
      return nextItem
    }

    const isPlaceLeft = this._options.maxItems < 0 || this._options.maxItems > totalCount
    if (!readyCount && isPlaceLeft) {
      const newItem = await this._generator()
      this.active[id] = newItem
      return newItem
    }

    return new Promise((resolve) => {
      this.waiting.push((item: T) => {
        this.active[id] = item
        resolve(item)
      })
    })
  }

  public cancel(id: string, cancel: (item: T) => void): void {
    const item = this.active[id]
    if (!item) {
      return
    }
    cancel(item)

    delete this.active[id]
  }

  public isActive(id: string) {
    return !!this.active[id]
  }

  public releaseItem(id: string, item: T) {
    delete this.active[id]

    if (!this.waiting.length) {
      this.ready.push(item)
      return
    }

    const next = this.waiting.pop()!
    next(item)
  }
}