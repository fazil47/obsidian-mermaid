## Prototype 

For the prototype use [oxdraw](https://github.com/RohanAdwankar/oxdraw) as the editor view. The user is expected to install `oxdraw` locally for the first version, so it will be desktop only. 

Obsidian natively supports mermaid blocks, add a button to edit a `mmd` snipped in the `oxdraw` editor like this:
![[oxdraw-block-edit-button-mockup.png]]

When the user clicks on that, open up that snippet in the editor in a new tab. After the user edits it, and clicks on a save button, then replace the original snippet in the markdown file. While replacing, the snippet should be stripped out of the `oxdraw` comments.

For the prototype use the normal `oxdraw` editor, but in a follow up remove the extra functionality `oxdraw` supports like colored blocks, since those can't be rendered by Obsidian anyway. Don't remove the ability to move blocks around, but strip that out on save as before.