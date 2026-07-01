const MIN_PANE_PX = 150;
const app = document.getElementById('app');
const mainDivider = document.getElementById('divider-main');
const htmlDivider = document.getElementById('divider-html');
const editorPane = document.getElementById('editor-pane');
const workspace = document.getElementById('workspace');
const iframePane = document.getElementById('iframe-pane');
const rightPane = document.getElementById('right-col');

function getOrientation(event) {
  const isHorizontal = window.innerWidth > 900;
  const dividerSize = isHorizontal 
    ? mainDivider.offsetWidth 
    : mainDivider.offsetHeight;
  const workspaceSize = isHorizontal 
    ? workspace.offsetWidth 
    : workspace.offsetHeight;

  return {
    totalPx: workspaceSize,
    availablePx: workspaceSize - dividerSize,
    currentEditorPx: isHorizontal ? editorPane.offsetWidth : editorPane.offsetHeight,
    adjustmentPx: isHorizontal ? event.movementX : event.movementY
  };
}

function resizePanes(event) {
  const { totalPx, availablePx, currentEditorPx, adjustmentPx } = getOrientation(event);

  // We'll get pixel width / height to then convert to %
  // New editor width / height leaves min 150px for both editor and right pane width 
  // (meaning, max editor width of total width or height - divider width or height - 150 px)
  let newEditorPx = Math.max(
    Math.min(
      currentEditorPx + adjustmentPx, 
      availablePx - MIN_PANE_PX
    ), MIN_PANE_PX
  );

  // Adjust editor width / height. Right pane width / height will flex accordingly.
  let newEditorPxPct = newEditorPx / totalPx;
  editorPane.style.flexBasis = `${newEditorPxPct * 100}%`;
}

function resizePanesHTML(event) {
  // Resize the panes within the right hand side when HTML is selected
  const totalPx = rightPane.offsetHeight;
  const availablePx = totalPx - htmlDivider.offsetHeight;
  const currentIframePx = iframePane.offsetHeight;
  const adjustmentPx = event.movementY;

  let newIframePx = Math.max(
    Math.min(
      currentIframePx + adjustmentPx, 
      availablePx - MIN_PANE_PX
    ), MIN_PANE_PX
  );

  let newIframePxPct = newIframePx / totalPx;
  iframePane.style.flexBasis = `${newIframePxPct * 100}%`;
}

function makeDraggable(divider, container, onMove) {
  let isDragging = false;

  divider.addEventListener('mousedown', () => {
    isDragging = true;

    // Prevent mouse events from being captured by the iframe
    // if our mouse hovers over the iframe while dragging
    iframePane.style.pointerEvents = 'none';
  });

  container.addEventListener('mousemove', event => {
    if (isDragging) {
      onMove(event);
    }
  });

  container.addEventListener('mouseup', () => {
    isDragging = false;
    iframePane.style.pointerEvents = '';
    
    // Because the divider has tabIndex="0" in the HTML,
    // the divider maintains browser focus even after we click off
    // We need to call the blur method so that it releases focus
    divider.blur();
  });
}

export function initializeResizers() {
  // Initializes the main resizer between the editor and right hand side (output)
  makeDraggable(mainDivider, app, resizePanes);

  // Initializes the second resizer when HTML is selected
  // between the iframe and output panes
  makeDraggable(htmlDivider, rightPane, resizePanesHTML);
}