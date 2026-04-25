
## Prototype 1

For the prototype use [oxdraw](https://github.com/RohanAdwankar/oxdraw) as the editor view. The user is expected to install `oxdraw` locally for the first version, so it will be desktop only. 

Obsidian natively supports mermaid blocks, add a button to edit a `mmd` snipped in the `oxdraw` editor like this:
![[oxdraw-block-edit-button-mockup.png]]

When the user clicks on that, open up that snippet in the editor in a new tab. After the user edits it, and clicks on a save button, then replace the original snippet in the markdown file. While replacing, the snippet should be stripped out of the `oxdraw` comments.

For the prototype use the normal `oxdraw` editor, but in a follow up remove the extra functionality `oxdraw` supports like colored blocks, since those can't be rendered by Obsidian anyway. Don't remove the ability to move blocks around, but strip that out on save as before.

## Prototype 2

Prototype 1 worked, it was a little brittle, but I was able to edit a snippet in the editor. But it was a failure because I realized that `oxdraw` is primarily for editing the appearance of `mmd` data that's already ready. It saves its changes to comments in the snippet, and it has limited ability to edit the actual `mmd` data.

So for prototype 2 I'm going to fork `oxdraw` and add functionality for adding nodes (rectangle only for now), adding connection (basic arrow for now) and edit label for the selected node/edge and then use that for the plugin.

`oxdraw` already has the code to edit the `mmd` data, but it's restricted to deleting nodes. Extend that to let the user add rectangle nodes, for making basic connections and for editing labels.