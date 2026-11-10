/**
 * One format for every plugin-authored reminder that enters the model context.
 *
 * Shape:
 *   <system-reminder>
 *   [<source>] <headline>
 *
 *   <detail>
 *   </system-reminder>
 *
 * `source` is the plugin package name, so a reader can tell which plugin wrote
 * the message. A closing tag embedded in user-provided detail is escaped: the
 * frame must not end early.
 */

const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'

/** Render the model-facing text of one reminder. */
export function reminderText(source, headline, detail = '') {
  const title = String(headline).trim()
  const body = String(detail).trim()
  const text = body === '' ? `[${source}] ${title}` : `[${source}] ${title}\n\n${body}`
  return `${OPEN}\n${text.replaceAll(CLOSE, '<\\/system-reminder>')}\n${CLOSE}`
}

/** Render the one-line summary the chat UI shows for the same reminder. */
export function reminderSummary(source, headline) {
  const title = String(headline).trim().replace(/\s+/g, ' ')
  return `[${source}] ${title}`
}
