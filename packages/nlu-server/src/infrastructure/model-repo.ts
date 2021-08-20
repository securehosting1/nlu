import { Logger } from '@botpress/logger'
import * as NLUEngine from '@botpress/nlu-engine'
import Bluebird from 'bluebird'
import chokidar from 'chokidar'
import fse, { WriteStream } from 'fs-extra'
import _ from 'lodash'
import path from 'path'
import { Stream } from 'stream'
import tar from 'tar'
import tmp from 'tmp'
import { getAppDataPath } from '../app-data'
import {
  Database,
  DBStorageDriver,
  DiskStorageDriver,
  GhostService,
  ScopedGhostService,
  MemoryObjectCache
} from './ghost'

interface FSDriver {
  driver: 'fs'
}

interface DBDriver {
  driver: 'db'
  dbURL: string
}

export type ModelRepoOptions = (FSDriver | DBDriver) & {
  modelDir: string
}

interface ModelOwnershipOptions {
  appId: string
  appSecret: string
}

interface PruneOptions extends ModelOwnershipOptions {
  keep: number
}

const MODELS_DIR = './models'
const MODELS_EXT = 'model'

const { modelIdService } = NLUEngine

// TODO: add a customizable modelDir
const defaultOtpions: ModelRepoOptions = {
  driver: 'fs',
  modelDir: getAppDataPath()
}

export class ModelRepository {
  private _ghost: GhostService
  private _db: Database
  private _options: ModelRepoOptions
  private _logger: Logger

  constructor(logger: Logger, options: Partial<ModelRepoOptions> = {}, watcher: chokidar.FSWatcher) {
    this._logger = logger.sub('model-repo')
    const isDefined = _.negate(_.isUndefined)
    this._options = { ...defaultOtpions, ..._.pickBy(options, isDefined) } as ModelRepoOptions

    this._db = new Database(this._logger)
    const diskDriver = new DiskStorageDriver({ basePath: this._options.modelDir })
    const dbdriver = new DBStorageDriver(this._db)
    const cache = new MemoryObjectCache(watcher)

    this._ghost = new GhostService(diskDriver, dbdriver, cache, this._logger)
  }

  async initialize() {
    this._logger.debug('Model service initializing...')
    if (this._options.driver === 'db') {
      await this._db.initialize('postgres', this._options.dbURL)
    }
    await this._ghost.initialize(this._options.driver === 'db')
  }

  public async hasModel(modelId: NLUEngine.ModelId, options: ModelOwnershipOptions): Promise<boolean> {
    return !!(await this.getModel(modelId, options))
  }

  /**
   *
   * @param modelId The desired model id
   * @returns the corresponding model
   */
  public async getModel(
    modelId: NLUEngine.ModelId,
    options: ModelOwnershipOptions
  ): Promise<NLUEngine.Model | undefined> {
    const scopedGhost = this._getScopedGhostForAppID(options.appId)

    const stringId = modelIdService.toString(modelId)
    const fExtension = this._getFileExtension(options.appSecret)
    const fname = `${stringId}.${fExtension}`

    if (!(await scopedGhost.fileExists(MODELS_DIR, fname))) {
      return
    }
    const buffStream = new Stream.PassThrough()
    buffStream.end(await scopedGhost.readFileAsBuffer(MODELS_DIR, fname))
    const tmpDir = tmp.dirSync({ unsafeCleanup: true })

    const tarStream = tar.x({ cwd: tmpDir.name, strict: true }, ['model']) as WriteStream
    buffStream.pipe(tarStream)
    await new Promise((resolve) => tarStream.on('close', resolve))

    const modelBuff = await fse.readFile(path.join(tmpDir.name, 'model'))
    let mod
    try {
      mod = JSON.parse(modelBuff.toString())
    } catch (err) {
      await scopedGhost.deleteFile(MODELS_DIR, fname)
    } finally {
      tmpDir.removeCallback()
      return mod
    }
  }

  public async saveModel(model: NLUEngine.Model, options: ModelOwnershipOptions): Promise<void | void[]> {
    const serialized = JSON.stringify(model)

    const stringId = modelIdService.toString(model.id)
    const fExtension = this._getFileExtension(options.appSecret)
    const fname = `${stringId}.${fExtension}`

    const scopedGhost = this._getScopedGhostForAppID(options.appId)

    // TODO replace that logic with in-memory streams
    const tmpDir = tmp.dirSync({ unsafeCleanup: true })
    const tmpFileName = path.join(tmpDir.name, 'model')
    await fse.writeFile(tmpFileName, serialized)
    const archiveName = path.join(tmpDir.name, fname)
    await tar.create(
      {
        file: archiveName,
        cwd: tmpDir.name,
        portable: true,
        gzip: true
      },
      ['model']
    )
    const buffer = await fse.readFile(archiveName)
    await scopedGhost.upsertFile(MODELS_DIR, fname, buffer)
    tmpDir.removeCallback()
  }

  public async listModels(
    options: ModelOwnershipOptions,
    filters: Partial<NLUEngine.ModelId> = {}
  ): Promise<NLUEngine.ModelId[]> {
    const scopedGhost = this._getScopedGhostForAppID(options.appId)

    const fextension = this._getFileExtension(options.appSecret)
    const files = await scopedGhost.directoryListing(MODELS_DIR, `*.${fextension}`, undefined, undefined, {
      sortOrder: {
        column: 'modifiedOn',
        desc: true
      }
    })

    const modelIds = files
      .map((f) => f.substring(0, f.lastIndexOf(`.${fextension}`)))
      .filter((stringId) => modelIdService.isId(stringId))
      .map((stringId) => modelIdService.fromString(stringId))

    return _.filter(modelIds, filters)
  }

  public async pruneModels(
    options: PruneOptions,
    filters: Partial<NLUEngine.ModelId> = {}
  ): Promise<NLUEngine.ModelId[]> {
    const models = await this.listModels(options, filters)

    const { keep } = options
    const toPrune = models.slice(keep)
    await Bluebird.each(toPrune, (m) => this.deleteModel(m, options))

    return toPrune
  }

  public async exists(modelId: NLUEngine.ModelId, options: ModelOwnershipOptions): Promise<boolean> {
    const scopedGhost = this._getScopedGhostForAppID(options.appId)

    const stringId = modelIdService.toString(modelId)
    const fExtension = this._getFileExtension(options.appSecret)
    const fname = `${stringId}.${fExtension}`

    return scopedGhost.fileExists(MODELS_DIR, fname)
  }

  public async deleteModel(modelId: NLUEngine.ModelId, options: ModelOwnershipOptions): Promise<void> {
    const scopedGhost = this._getScopedGhostForAppID(options.appId)

    const stringId = modelIdService.toString(modelId)
    const fExtension = this._getFileExtension(options.appSecret)
    const fname = `${stringId}.${fExtension}`

    return scopedGhost.deleteFile(MODELS_DIR, fname)
  }

  private _getScopedGhostForAppID(appId: string): ScopedGhostService {
    return appId ? this._ghost.forBot(appId) : this._ghost.root()
  }

  private _getFileExtension(appSecret: string) {
    const secretHash = this._computeSecretHash(appSecret)
    return `${secretHash}.${MODELS_EXT}`
  }

  private _computeSecretHash(appSecret: string): string {
    return modelIdService.halfmd5(appSecret) // makes shorter file name than full regular md5
  }
}