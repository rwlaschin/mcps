import path from 'node:path'

const workerName = (file, label) => {
  const match = file.match(/^(.*?)(\.(?:trace\.json|[^./]+))$/)
  return match ? `${match[1]}.worker-${label}${match[2]}` : `${file}.worker-${label}`
}

export const deriveWorkerProfile = (baseExecArgv, label) => {
  const values = Object.fromEntries(baseExecArgv.map((argument) => argument.split('=', 2)).filter(([key, value]) => value !== undefined).map(([key, value]) => [key, value]))
  const names = {
    cpu: values['--cpu-prof-name'],
    heap: values['--heap-prof-name'],
  }
  const derived = Object.fromEntries(Object.entries(names).filter(([, value]) => value).map(([kind, value]) => [kind, workerName(value, label)]))
  const workerArgv = []
  for (let index = 0; index < baseExecArgv.length; index += 1) {
    const argument = baseExecArgv[index]
    if (argument === '--trace-event-categories' || argument === '--trace-event-file-pattern') { index += 1; continue }
    if (argument.startsWith('--trace-event-categories=') || argument.startsWith('--trace-event-file-pattern=')) continue
    workerArgv.push(argument)
  }
  const execArgv = workerArgv.map((argument) => {
    const match = argument.match(/^(--(?:cpu-prof-name|heap-prof-name)=)(.*)$/)
    return match ? `${match[1]}${derived[match[1].startsWith('--cpu') ? 'cpu' : 'heap']}` : argument
  })
  const artifacts = { ...derived }
  if (artifacts.cpu && values['--cpu-prof-dir']) artifacts.cpu = path.join(values['--cpu-prof-dir'], artifacts.cpu)
  if (artifacts.heap && values['--heap-prof-dir']) artifacts.heap = path.join(values['--heap-prof-dir'], artifacts.heap)
  return { execArgv, artifacts }
}
