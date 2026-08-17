export const STREAM_TARGET_URL_STATE_KEY = 'streamTargetUrl'

/**
 * Global URL selected from stream/discovery to represent the current primary target.
 */
export function useStreamTargetUrl() {
  return useState<string>(STREAM_TARGET_URL_STATE_KEY, () => '')
}
