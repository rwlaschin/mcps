import path from 'node:path'

const delegateMethods = [
  'readDirSync', 'directoryExists', 'directoryExistsSync', 'realpathSync',
  'getCurrentDirectory', 'glob', 'globSync', 'isCaseSensitive', 'mkdir', 'mkdirSync',
]

export class PrefetchedFileSystemHost {
  constructor(root, sources, delegate) {
    if (!path.isAbsolute(root)) throw new Error('project root must be absolute')
    this.root = path.resolve(root)
    this.delegate = delegate
    this.caseSensitive = delegate.isCaseSensitive()
    this.sources = new Map()

    for (const [relative, source] of sources) {
      if (path.isAbsolute(relative)) throw new Error(`prefetched source path must be relative: ${relative}`)
      if (typeof source !== 'string') throw new TypeError(`prefetched source must be text: ${relative}`)
      const absolute = path.resolve(this.root, relative)
      const fromRoot = path.relative(this.root, absolute)
      if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
        throw new Error(`prefetched source path escapes project root: ${relative}`)
      }
      const key = this.#key(absolute)
      if (this.sources.has(key)) throw new Error(`prefetched source canonical path collision: ${relative}`)
      this.sources.set(key, source)
    }

    for (const method of delegateMethods) {
      this[method] = (...args) => delegate[method](...args)
    }
  }

  #key(file) {
    const absolute = path.resolve(file)
    return this.caseSensitive ? absolute : absolute.toLocaleLowerCase('en-US')
  }

  #sourcePath(relative) {
    if (path.isAbsolute(relative)) throw new Error(`prefetched source path must be relative: ${relative}`)
    const absolute = path.resolve(this.root, relative)
    const fromRoot = path.relative(this.root, absolute)
    if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      throw new Error(`prefetched source path escapes project root: ${relative}`)
    }
    return absolute
  }

  upsert(relative, source) {
    if (typeof source !== 'string') throw new TypeError(`prefetched source must be text: ${relative}`)
    this.sources.set(this.#key(this.#sourcePath(relative)), source)
  }

  remove(relative) {
    this.sources.delete(this.#key(this.#sourcePath(relative)))
  }

  #affectsMapped(file) {
    const key = this.#key(file)
    const prefix = key.endsWith(path.sep) ? key : `${key}${path.sep}`
    if (this.sources.has(key)) return true
    for (const mapped of this.sources.keys()) if (mapped.startsWith(prefix)) return true
    return false
  }

  #rejectMapped(operation, ...files) {
    if (files.some((file) => this.#affectsMapped(file))) {
      throw new Error(`${operation} cannot affect a prefetched source`)
    }
  }

  readFileSync(file, encoding) {
    const mapped = this.sources.get(this.#key(file))
    return mapped !== undefined ? mapped : this.delegate.readFileSync(file, encoding)
  }

  readFile(file, encoding) {
    const mapped = this.sources.get(this.#key(file))
    return mapped !== undefined ? Promise.resolve(mapped) : this.delegate.readFile(file, encoding)
  }

  fileExistsSync(file) {
    return this.sources.has(this.#key(file)) || this.delegate.fileExistsSync(file)
  }

  fileExists(file) {
    return this.sources.has(this.#key(file)) ? Promise.resolve(true) : this.delegate.fileExists(file)
  }

  writeFileSync(file, text) {
    this.#rejectMapped('write', file)
    return this.delegate.writeFileSync(file, text)
  }

  async writeFile(file, text) {
    this.#rejectMapped('write', file)
    return this.delegate.writeFile(file, text)
  }

  deleteSync(file) {
    this.#rejectMapped('delete', file)
    return this.delegate.deleteSync(file)
  }

  async delete(file) {
    this.#rejectMapped('delete', file)
    return this.delegate.delete(file)
  }

  moveSync(source, destination) {
    this.#rejectMapped('move', source, destination)
    return this.delegate.moveSync(source, destination)
  }

  async move(source, destination) {
    this.#rejectMapped('move', source, destination)
    return this.delegate.move(source, destination)
  }

  copySync(source, destination) {
    this.#rejectMapped('copy', destination)
    return this.delegate.copySync(source, destination)
  }

  async copy(source, destination) {
    this.#rejectMapped('copy', destination)
    return this.delegate.copy(source, destination)
  }
}
