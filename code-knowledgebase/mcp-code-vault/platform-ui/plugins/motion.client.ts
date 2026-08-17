/**
 * VueUse Motion plugin for Nuxt — enables v-motion-* directives and spring-based
 * animations (e.g. v-motion-roll-visible-bottom for staggered card entrances).
 */
import { MotionPlugin } from '@vueuse/motion'

export default defineNuxtPlugin((nuxt) => {
  nuxt.vueApp.use(MotionPlugin)
})
