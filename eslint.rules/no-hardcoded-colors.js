/**
 * Custom ESLint rule: no-hardcoded-colors
 * Disallows raw hex (#RRGGBB, #RGB) or rgb()/rgba() literals in component code.
 * Use CSS token variables instead: var(--md-sys-color-*).
 */

export default {
  rules: {
    'no-hardcoded-colors': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow raw hardcoded hex colors (#fff, #000, #RRGGBB) or rgb()/rgba() literals in component markup',
        },
        schema: [],
        messages: {
          hardcoded:
            'Hardcoded color literal \'{{literal}}\' is not allowed. Use var(--md-sys-color-*) tokens or the Tailwind color tokens instead.',
        },
      },
      create(context) {
        const hexRe = /(^|[^\w])#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?![0-9a-fA-F])/
        const rgbRe = /(rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[0-9]*\.?[0-9]+\s*)?\))/

        return {
          Literal(node) {
            if (typeof node.value !== 'string') return
            const filename = context.getFilename()
            // Skip theme files where literals are part of token definitions; skip config files
            const relativePath = filename.replace(/\\/g, '/')
            if (
              relativePath.includes('src/theme/') ||
              relativePath.endsWith('src/index.css') ||
              relativePath.includes('eslint.rules/') ||
              relativePath.endsWith('vite.config.ts') ||
              relativePath.endsWith('tailwind.config.js')
            )
              return
            const str = node.value
            if (hexRe.test(str) || rgbRe.test(str)) {
              context.report({ node, messageId: 'hardcoded', data: { literal: str } })
            }
          },
        }
      },
    },
  },
}