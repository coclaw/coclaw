---
'@coclaw/ui': patch
---

fix(ui): align ChatInput buttons with disabled textarea by removing inline-flex line-box

The middle wrapper around the chat textarea was a plain block `<div>`. Since the Nuxt UI `UTextarea` root renders as `inline-flex`, the wrapper treated it as inline content and reserved a line box whose height includes the half-leading below the inline element's baseline, making the wrapper render about 5px taller than its child. With the form using `items-end`, the left/right 40px icon buttons looked vertically misaligned with the input box during the loading window when the textarea is disabled.

Adding `flex` to the middle wrapper makes it a flex container, which does not produce a line box for its children, so its height collapses to the actual `UTextarea` root height (40px) and the columns line up regardless of disabled state.
