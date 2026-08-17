import { getServers } from '../utils/discovery-store'

export default defineEventHandler(() => {
  return { servers: getServers() }
})
