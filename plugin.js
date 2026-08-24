const MARKER = '__task_colors__=';
const TASK_COLORS_KEY = 'taskColors';

let taskColorsSynced = {};

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadTaskColors() {
  try {
    const saved = await PluginAPI.loadSyncedData(TASK_COLORS_KEY);
    if (saved) {
      taskColorsSynced = JSON.parse(saved);
    } else {
      taskColorsSynced = {};
    }
  } catch (e) {
    taskColorsSynced = {};
  }
}

function getCurrentColor(notes, taskId) {
  // Primary source: synced plugin storage
  if (taskColorsSynced && taskColorsSynced[taskId]) {
    return taskColorsSynced[taskId];
  }
  // Backport/fallback: legacy notes marker
  if (!notes) return '';
  const markerIdx = notes.indexOf(MARKER);
  if (markerIdx === -1) return '';
  const jsonStart = markerIdx + MARKER.length;
  const jsonEnd = notes.indexOf('\n', jsonStart);
  const jsonStr = jsonEnd === -1 ? notes.substring(jsonStart) : notes.substring(jsonStart, jsonEnd);
  try {
    const data = JSON.parse(jsonStr);
    const legacy = data[taskId] || '';
    if (legacy) {
      // Backport: migrate legacy note color into synced storage
      saveTaskColor(taskId, legacy, true);
    }
    return legacy;
  } catch (e) {
    return '';
  }
}

async function saveTaskColor(taskId, color, silent = false) {
  if (color) {
    taskColorsSynced[taskId] = color;
  } else {
    delete taskColorsSynced[taskId];
  }
  await PluginAPI.persistDataSynced(JSON.stringify(taskColorsSynced), TASK_COLORS_KEY);
  if (!silent) {
    markColorRefreshDirty();
  }
}

async function clearColorFromNotes(taskId) {
  const tasks = await PluginAPI.getTasks();
  for (const task of tasks) {
    if (task.id !== taskId) continue;
    const notes = task.notes || '';
    const markerIdx = notes.indexOf(MARKER);
    if (markerIdx === -1) return;
    const newNotes = setColorInNotes(notes, taskId, '');
    if (newNotes !== notes) {
      await PluginAPI.updateTask(taskId, { notes: newNotes });
    }
    return;
  }
}

function setColorInNotes(notes, taskId, color) {
  let data = {};
  let beforeMarker = '';
  let afterMarker = '';

  if (notes) {
    const markerIdx = notes.indexOf(MARKER);
    if (markerIdx !== -1) {
      const jsonStart = markerIdx + MARKER.length;
      const jsonEnd = notes.indexOf('\n', jsonStart);
      const jsonStr = jsonEnd === -1 ? notes.substring(jsonStart) : notes.substring(jsonStart, jsonEnd);
      try {
        data = JSON.parse(jsonStr);
      } catch (e) {
        // ignore corrupt marker
      }
      beforeMarker = notes.substring(0, markerIdx);
      afterMarker = jsonEnd === -1 ? '' : notes.substring(jsonEnd + 1);
    } else {
      beforeMarker = notes;
    }
  }

  if (color) {
    data[taskId] = color;
  } else {
    delete data[taskId];
  }

  const keys = Object.keys(data);
  if (keys.length === 0) {
    const combined = beforeMarker + afterMarker;
    return combined.length ? combined : '';
  }

  const markerLine = MARKER + JSON.stringify(data);
  const combined = beforeMarker + afterMarker;
  return combined ? combined + '\n' + markerLine : markerLine;
}

function normalizeTitle(title) {
  return (title || '').trim().toLowerCase();
}

function isDarkMode() {
  if (typeof document === 'undefined') return false;
  const html = document.documentElement;
  const body = document.body;
  return html.classList.contains('dark-theme') ||
         html.classList.contains('theme-dark') ||
         body.classList.contains('dark-theme') ||
         body.classList.contains('theme-dark') ||
         html.getAttribute('data-theme') === 'dark' ||
         body.getAttribute('data-theme') === 'dark';
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

function isLightColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.6;
}

function getContrastTextColor(hex) {
  return isLightColor(hex) ? '#1a1a1a' : '#ffffff';
}

function applyColorToTaskElement(taskId, color, taskTitle) {
  try {
    const taskHost = document.getElementById('t-' + taskId);
    const scheduleHost = document.querySelector('schedule-event#t-' + taskId);
    const plannerHost = document.querySelector('planner-task#t-' + taskId);

    const targets = [];
    if (taskHost) targets.push(taskHost);
    if (scheduleHost) targets.push(scheduleHost);
    if (plannerHost) targets.push(plannerHost);

    // Planner/board fallback: if no exact ID match, search by task title text.
    // This covers views where the task ID is not present on the card element.
    if (targets.length === 0 && taskTitle) {
      const normalized = normalizeTitle(taskTitle);
      const allPlannerTasks = document.querySelectorAll('planner-task');
      let matched = 0;
      allPlannerTasks.forEach(el => {
        const titleEl = el.querySelector('.wrap .title');
        const titleText = titleEl ? normalizeTitle(titleEl.textContent) : '';
        if (!titleText) return;

        const exactMatch = titleText === normalized;
        const containsMatch = titleText.includes(normalized) || normalized.includes(titleText);
        
        if (exactMatch || containsMatch) {
          targets.push(el);
          matched++;
        }
      });
      
      if (matched > 0) {
        PluginAPI.log.info('[TaskColor] Title fallback matched', matched, 'cards for task:', taskId);
      } else {
        PluginAPI.log.warn('[TaskColor] Title fallback found NO match for task:', taskId);
      }
    }

    targets.forEach(host => {
      if (!host) return;
      if (color) {
        host.style.setProperty('background-color', color, 'important');
        const inner = host.querySelector('.inner-wrapper');
        if (inner) inner.style.setProperty('background-color', color, 'important');
        const box = host.querySelector('.box');
        if (box) box.style.setProperty('background-color', color, 'important');
        const swipe = host.querySelector('swipe-block');
        if (swipe) swipe.style.setProperty('background-color', color, 'important');

        // Auto text color for dark mode readability
        if (isDarkMode()) {
          const textColor = getContrastTextColor(color);
          host.style.setProperty('color', textColor, 'important');
        }
      } else {
        host.style.removeProperty('background-color');
        const inner = host.querySelector('.inner-wrapper');
        if (inner) inner.style.removeProperty('background-color');
        const box = host.querySelector('.box');
        if (box) box.style.removeProperty('background-color');
        const swipe = host.querySelector('swipe-block');
        if (swipe) swipe.style.removeProperty('background-color');
        host.style.removeProperty('color');
      }
    });

    if (targets.length === 0 && !taskHost && !scheduleHost && !plannerHost) {
      PluginAPI.log.warn('[TaskColor] No DOM element found for task:', taskId);
    }
  } catch (e) {
    // ignore
  }
}

let tagColors = {};
let lastCurrentTaskId = null;
let lastPickedColor = '#000000';
let favoriteColors = [];

async function loadTagColors() {
  try {
    const saved = await PluginAPI.loadSyncedData('tagColors');
    if (saved) {
      tagColors = JSON.parse(saved);
    } else {
      tagColors = {};
    }
  } catch (e) {
    tagColors = {};
  }
}

async function loadFavorites() {
  try {
    const saved = await PluginAPI.loadSyncedData('favoriteColors');
    if (saved) {
      favoriteColors = JSON.parse(saved);
    } else {
      favoriteColors = [];
    }
  } catch (e) {
    favoriteColors = [];
  }
}

function saveFavorite(color) {
  if (!color || favoriteColors.includes(color)) return;
  favoriteColors.unshift(color);
  if (favoriteColors.length > 12) favoriteColors.pop();
  PluginAPI.persistDataSynced(JSON.stringify(favoriteColors), 'favoriteColors');
}

function getEffectiveColor(task) {
  const noteColor = getCurrentColor(task.notes, task.id);
  if (noteColor) return noteColor;
  if (task.tagIds && task.tagIds.length > 0) {
    for (const tagId of task.tagIds) {
      if (tagColors[tagId]) return tagColors[tagId];
    }
  }
  return '';
}

async function refreshParentColors() {
  try {
    const tasks = await PluginAPI.getTasks();
    tasks.forEach(task => {
      const color = getEffectiveColor(task);
      applyColorToTaskElement(task.id, color, task.title);
    });
  } catch (e) {
    // ignore
  }
}

let parentObserverStarted = false;
let colorRefreshDirty = false;

function startParentObserver() {
  if (parentObserverStarted) return;
  parentObserverStarted = true;

  // Poll every 5 seconds, but only when the app window is focused
  setInterval(async () => {
    try {
      if (PluginAPI.isWindowFocused && !PluginAPI.isWindowFocused()) {
        return; // Skip refresh when app is in background
      }
      await refreshParentColors();
    } catch (e) {
      // ignore
    }
  }, 5000);

  // Dirty-flag loop: when hooks or user actions set colorRefreshDirty=true,
  // refresh ASAP without waiting for the next poll tick.
  setInterval(async () => {
    if (!colorRefreshDirty) return;
    colorRefreshDirty = false;
    try {
      if (PluginAPI.isWindowFocused && !PluginAPI.isWindowFocused()) {
        colorRefreshDirty = true; // retry when window regains focus
        return;
      }
      await refreshParentColors();
    } catch (e) {
      // ignore
    }
  }, 1000);
}

function markColorRefreshDirty() {
  colorRefreshDirty = true;
}

const PRESET_COLORS = [
  '#f28d8d', '#e57373', '#d32f2f',
  '#ffb74d', '#ff9800', '#f57c00',
  '#fff176', '#fdd835', '#f9a825',
  '#aed581', '#8bc34a', '#689f38',
  '#64b5f6', '#42a5f5', '#1e88e5',
  '#90caf9', '#2196f3', '#1976d2',
  '#ce93d8', '#ab47bc', '#7b1fa2',
  '#f48fb1', '#ec407a', '#c2185b',
  '#000000', '#555555', '#aaaaaa', '#ffffff'
];

function openColorPickerDialog(currentColor) {
  return new Promise((resolve, reject) => {
    const dialogId = 'color-dialog-' + Date.now();
    let selectedColor = currentColor;
    
    function buildPaletteHtml() {
      const isFav = (c) => favoriteColors.includes(c);
      
      const favHtml = favoriteColors.length > 0 ?
        '<div style="margin-bottom:10px;">' +
          '<div style="font-size:0.8em;color:var(--text-color-muted);margin-bottom:4px;">FAVORITES</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:6px;">' +
            favoriteColors.map(c =>
              '<div class="color-swatch" data-color="' + c + '" data-favorite="true" style="width:24px;height:24px;border-radius:50%;background:' + c + ';cursor:pointer;border:2px solid ' + (c === selectedColor ? 'var(--c-primary)' : 'var(--divider-color)') + ';position:relative;" title="Click to select, right-click to remove">' +
                (isFav(c) ? '<span style="position:absolute;top:-4px;right:-4px;font-size:10px;color:var(--c-primary);">★</span>' : '') +
              '</div>'
            ).join('') +
          '</div>' +
        '</div>' : '';

      const lastHtml = lastPickedColor && lastPickedColor !== currentColor ?
        '<div style="margin-bottom:10px;">' +
          '<div style="font-size:0.8em;color:var(--text-color-muted);margin-bottom:4px;">LAST PICKED</div>' +
          '<div style="display:inline-flex;align-items:center;">' +
            '<div class="color-swatch" data-color="' + lastPickedColor + '" style="width:28px;height:28px;border-radius:50%;background:' + lastPickedColor + ';cursor:pointer;border:2px solid var(--c-primary);" title="Last picked"></div>' +
          '</div>' +
        '</div>' : '';

      return lastHtml + favHtml +
        '<div id="color-palette" style="display:grid;grid-template-columns:repeat(9,1fr);gap:6px;">' +
          PRESET_COLORS.map(c =>
            '<div class="color-swatch' + (c === selectedColor ? ' selected' : '') + '" data-color="' + c + '" data-favorite="false" style="width:28px;height:28px;border-radius:50%;background:' + c + ';cursor:pointer;border:2px solid ' + (c === selectedColor ? 'var(--c-primary)' : 'var(--divider-color)') + ';position:relative;" title="Click to select, right-click to ' + (isFav(c) ? 'remove from' : 'add to') + ' favorites">' +
              (isFav(c) ? '<span style="position:absolute;top:-4px;right:-4px;font-size:10px;color:var(--c-primary);">★</span>' : '') +
            '</div>'
          ).join('') +
        '</div>' +
        '<div style="margin-top:12px;display:flex;align-items:center;gap:8px;">' +
          '<span style="color:var(--text-color);font-size:0.9em;">Custom:</span>' +
          '<input type="color" id="custom-color-picker" value="' + selectedColor + '" style="width:40px;height:28px;border:none;background:none;cursor:pointer;" />' +
          '<button id="btn-fav-current" style="background:transparent;border:1px solid var(--divider-color);color:var(--text-color);padding:4px 8px;border-radius:4px;cursor:pointer;font-size:0.8em;" title="Add custom color to favorites">★ Add to favorites</button>' +
        '</div>';
    }

    function updateSelection(color) {
      selectedColor = color;
      const paletteEl = document.getElementById(dialogId);
      if (!paletteEl) return;
      
      paletteEl.querySelectorAll('.color-swatch').forEach(swatch => {
        const swatchColor = swatch.getAttribute('data-color');
        if (swatchColor === color) {
          swatch.classList.add('selected');
          swatch.style.borderColor = 'var(--c-primary)';
        } else {
          swatch.classList.remove('selected');
          swatch.style.borderColor = 'var(--divider-color)';
        }
      });
      
      const custom = paletteEl.querySelector('#custom-color-picker');
      if (custom) custom.value = color;
    }

    const htmlContent = '<div id="' + dialogId + '" style="padding:8px 0;">' + buildPaletteHtml() + '</div>';

    PluginAPI.openDialog({
      title: 'Pick color',
      htmlContent: htmlContent,
      buttons: [
        { 
          label: 'Cancel',
          onClick: () => resolve(null)
        },
        {
          label: 'Save',
          color: 'primary',
          raised: true,
          onClick: () => {
            try {
              const paletteEl = document.getElementById(dialogId);
              const selected = paletteEl ? paletteEl.querySelector('.color-swatch.selected') : null;
              const custom = paletteEl ? paletteEl.querySelector('#custom-color-picker') : null;
              const chosen = selected ? selected.getAttribute('data-color') : (custom ? custom.value : currentColor);

              if (!chosen) {
                PluginAPI.showSnack({ msg: 'Please select a color', type: 'WARNING' });
                return;
              }

              lastPickedColor = chosen;
              saveFavorite(chosen);
              resolve(chosen);
            } catch (e) {
              reject(e);
            }
          }
        }
      ]
    }).catch(() => resolve(null));

    // Global click handler for swatches inside our dialog
    const clickHandler = (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (!swatch) return;
      
      const dialogEl = document.getElementById(dialogId);
      if (!dialogEl || !dialogEl.contains(swatch)) return;
      
      const color = swatch.getAttribute('data-color');
      if (!color) return;
      
      if (e.button === 2) {
        // Right click - toggle favorite
        e.preventDefault();
        if (favoriteColors.includes(color)) {
          favoriteColors = favoriteColors.filter(c => c !== color);
        } else {
          favoriteColors.unshift(color);
          if (favoriteColors.length > 12) favoriteColors.pop();
        }
        PluginAPI.persistDataSynced(JSON.stringify(favoriteColors), 'favoriteColors');
        
        // Rebuild dialog content with updated favorites
        const paletteEl = document.getElementById(dialogId);
        if (paletteEl) {
          paletteEl.innerHTML = buildPaletteHtml();
        }
      } else {
        // Left click - select color
        updateSelection(color);
      }
    };

    const favBtnHandler = (e) => {
      const btn = e.target.closest('#btn-fav-current');
      if (!btn) return;
      
      const dialogEl = document.getElementById(dialogId);
      if (!dialogEl || !dialogEl.contains(btn)) return;
      
      e.preventDefault();
      e.stopPropagation();
      
      const custom = document.getElementById('custom-color-picker');
      const color = custom ? custom.value : selectedColor;
      if (color && !favoriteColors.includes(color)) {
        favoriteColors.unshift(color);
        if (favoriteColors.length > 12) favoriteColors.pop();
        PluginAPI.persistDataSynced(JSON.stringify(favoriteColors), 'favoriteColors');
        PluginAPI.showSnack({ msg: 'Added to favorites', type: 'SUCCESS' });
        
        const paletteEl = document.getElementById(dialogId);
        if (paletteEl) {
          paletteEl.innerHTML = buildPaletteHtml();
        }
      }
    };

    document.addEventListener('click', clickHandler);
    document.addEventListener('contextmenu', (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (swatch) {
        const dialogEl = document.getElementById(dialogId);
        if (dialogEl && dialogEl.contains(swatch)) {
          e.preventDefault();
        }
      }
    });
    document.addEventListener('click', favBtnHandler);
    
    // Cleanup handlers after dialog closes
    const cleanup = () => {
      document.removeEventListener('click', clickHandler);
      document.removeEventListener('click', favBtnHandler);
    };
    
    // Store cleanup for potential later use
    window['_taskColorCleanup_' + dialogId] = cleanup;
  });
}

async function pickColorForTask(task) {
  if (!task) return;
  try {
    const currentColor = getCurrentColor(task.notes, task.id) || '#000000';
    const chosenColor = await openColorPickerDialog(currentColor);
    
    if (chosenColor) {
      lastPickedColor = chosenColor;
      saveFavorite(chosenColor);
      await saveTaskColor(task.id, chosenColor);
      await clearColorFromNotes(task.id);
      PluginAPI.showSnack({ msg: 'Color saved', type: 'SUCCESS' });
      markColorRefreshDirty();
    }
  } catch (e) {
    PluginAPI.showSnack({ msg: 'Failed to pick color: ' + e.message, type: 'ERROR' });
  }
}

async function handleColorAction() {
  try {
    PluginAPI.log.info('[TaskColor] Opening color action');
    let task = await PluginAPI.getSelectedTask();
    PluginAPI.log.info('[TaskColor] getSelectedTask:', task ? task.id : 'null');
    
    if (!task) {
      task = await PluginAPI.getFocusedTask();
      PluginAPI.log.info('[TaskColor] getFocusedTask:', task ? task.id : 'null');
    }
    if (!task && lastCurrentTaskId) {
      const tasks = await PluginAPI.getTasks();
      task = tasks.find(t => t.id === lastCurrentTaskId) || null;
      PluginAPI.log.info('[TaskColor] lastCurrentTaskId fallback:', task ? task.id : 'null');
    }

    if (task) {
      PluginAPI.log.info('[TaskColor] Opening color picker for task:', task.id);
      await pickColorForTask(task);
      return;
    }

    PluginAPI.log.info('[TaskColor] No task found, showing task picker');
    const tasks = await PluginAPI.getTasks();
    const activeTasks = tasks.filter(t => !t.isDone);
    if (activeTasks.length === 0) {
      PluginAPI.showSnack({ msg: 'No active tasks available', type: 'WARNING' });
      return;
    }

    // Load projects for filtering
    const projects = await PluginAPI.getAllProjects();
    const projectMap = {};
    projects.forEach(p => { projectMap[p.id] = p.title; });

    // Sort tasks: recent first (by updated desc), then by project
    const sortedTasks = activeTasks.slice().sort((a, b) => {
      const timeA = a.updated || a.created || 0;
      const timeB = b.updated || b.created || 0;
      if (timeB !== timeA) return timeB - timeA;
      return a.title.localeCompare(b.title);
    });

    // Build project options
    const projectOptions = ['<option value="">All projects</option>'];
    projects.forEach(p => {
      projectOptions.push('<option value="' + p.id + '">' + escapeHtml(p.title) + '</option>');
    });

    // Build initial task list HTML
    function buildTaskListHtml(taskList, filterColor = 'all', sortMode = 'recent') {
      let filtered = taskList.slice();
      
      // Apply color filter
      if (filterColor === 'colored') {
        filtered = filtered.filter(t => getEffectiveColor(t));
      } else if (filterColor === 'uncolored') {
        filtered = filtered.filter(t => !getEffectiveColor(t));
      }
      
      // Apply sort
      if (sortMode === 'color') {
        filtered = filtered.slice().sort((a, b) => {
          const colorA = getEffectiveColor(a);
          const colorB = getEffectiveColor(b);
          if (!colorA && !colorB) return 0;
          if (!colorA) return 1;
          if (!colorB) return -1;
          return colorA.localeCompare(colorB);
        });
      } else {
        filtered = filtered.slice().sort((a, b) => {
          const timeA = a.updated || a.created || 0;
          const timeB = b.updated || b.created || 0;
          return timeB - timeA;
        });
      }
      
      if (filtered.length === 0) {
        return '<div style="padding:12px;color:var(--text-color-muted);text-align:center;">No tasks match</div>';
      }
      return filtered.map(t => {
        const projectTitle = t.projectId ? (projectMap[t.projectId] || '') : '';
        const color = getEffectiveColor(t);
        const colorIndicator = color ? '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + color + ';margin-left:8px;vertical-align:middle;" title="' + color + '"></span>' : '';
        const label = escapeHtml(t.title) + colorIndicator + (projectTitle ? ' <span style="color:var(--text-color-muted);font-size:0.85em;">(' + escapeHtml(projectTitle) + ')</span>' : '');
        return '<div class="task-pick-item" data-task-id="' + t.id + '" style="padding:8px;cursor:pointer;border-bottom:1px solid var(--divider-color);display:flex;align-items:center;">' + label + '</div>';
      }).join('');
    }

    const pickerHtml = '<div id="task-picker-dialog" style="padding:8px 0;">' +
      '<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">' +
        '<input type="text" id="task-search-input" placeholder="Search tasks..." style="flex:2;min-width:140px;padding:6px;border-radius:4px;border:1px solid var(--divider-color);background:var(--card-bg);color:var(--text-color);font-family:var(--font-primary-stack);" />' +
        '<select id="task-project-filter" style="flex:1;min-width:100px;padding:6px;border-radius:4px;border:1px solid var(--divider-color);background:var(--card-bg);color:var(--text-color);font-family:var(--font-primary-stack);">' + projectOptions.join('') + '</select>' +
        '<select id="task-color-filter" style="flex:1;min-width:100px;padding:6px;border-radius:4px;border:1px solid var(--divider-color);background:var(--card-bg);color:var(--text-color);font-family:var(--font-primary-stack);">' +
          '<option value="all">All</option>' +
          '<option value="colored">Colored</option>' +
          '<option value="uncolored">Uncolored</option>' +
        '</select>' +
      '</div>' +
      '<div id="task-picker-list" style="max-height:300px;overflow-y:auto;border:1px solid var(--divider-color);border-radius:4px;background:var(--card-bg);">' +
        buildTaskListHtml(sortedTasks) +
      '</div>' +
    '</div>';

    let selectedTaskId = null;

    // Task picker event handlers (global, so they work inside dialog)
    const taskPickerClickHandler = (e) => {
      const item = e.target.closest('.task-pick-item');
      if (!item) return;
      
      const list = document.getElementById('task-picker-list');
      if (!list || !list.contains(item)) return;
      
      e.preventDefault();
      e.stopPropagation();
      
      // Remove previous selection
      list.querySelectorAll('.task-pick-item').forEach(el => {
        el.style.background = '';
        el.classList.remove('selected');
      });
      
      // Select clicked item
      item.style.background = 'var(--bg-lighter)';
      item.classList.add('selected');
      selectedTaskId = item.getAttribute('data-task-id');
    };

    const taskPickerInputHandler = () => {
      const searchInput = document.getElementById('task-search-input');
      const projectFilter = document.getElementById('task-project-filter');
      const colorFilter = document.getElementById('task-color-filter');
      const list = document.getElementById('task-picker-list');
      
      if (!searchInput || !projectFilter || !colorFilter || !list) return;
      
      const query = searchInput.value.toLowerCase().trim();
      const projectId = projectFilter.value;
      const colorMode = colorFilter.value;
      
      const filtered = sortedTasks.filter(t => {
        const matchesSearch = !query || t.title.toLowerCase().includes(query);
        const matchesProject = !projectId || t.projectId === projectId;
        const matchesColor = colorMode === 'all' || 
          (colorMode === 'colored' && getEffectiveColor(t)) ||
          (colorMode === 'uncolored' && !getEffectiveColor(t));
        return matchesSearch && matchesProject && matchesColor;
      });
      
      list.innerHTML = buildTaskListHtml(filtered, colorMode);
    };

    document.addEventListener('mousedown', taskPickerClickHandler, true);
    document.addEventListener('input', taskPickerInputHandler);
    document.addEventListener('change', taskPickerInputHandler);

    await PluginAPI.openDialog({
      title: 'Pick a task',
      htmlContent: pickerHtml,
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Pick',
          color: 'primary',
          raised: true,
          onClick: () => {
            PluginAPI.log.info('[TaskColor] Pick clicked, selectedTaskId:', selectedTaskId);
            
            // Fallback: if selectedTaskId wasn't set by mousedown, try querying DOM
            if (!selectedTaskId) {
              const selectedEl = document.querySelector('#task-picker-list .task-pick-item.selected');
              selectedTaskId = selectedEl ? selectedEl.getAttribute('data-task-id') : null;
              PluginAPI.log.info('[TaskColor] Pick fallback DOM selection:', selectedTaskId);
            }
            
            const searchInput = document.getElementById('task-search-input');
            const projectFilter = document.getElementById('task-project-filter');
            const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';
            const projectId = projectFilter ? projectFilter.value : '';
            
            PluginAPI.log.info('[TaskColor] Task picker selected:', selectedTaskId);
          }
        }
      ]
    });

    PluginAPI.log.info('[TaskColor] After dialog, selectedTaskId:', selectedTaskId);

    if (selectedTaskId) {
      const task = activeTasks.find(t => t.id === selectedTaskId);
      if (task) {
        PluginAPI.log.info('[TaskColor] Opening color picker for picked task:', task.id);
        await pickColorForTask(task);
      } else {
        PluginAPI.log.warn('[TaskColor] Task not found for selectedTaskId:', selectedTaskId);
      }
    } else {
      PluginAPI.log.warn('[TaskColor] No task selected in picker');
    }
  } catch (e) {
    PluginAPI.showSnack({ msg: 'Failed to open color picker: ' + e.message, type: 'ERROR' });
    PluginAPI.log.error('[TaskColor] Error');
  }
}

function register() {
  PluginAPI.registerHook(PluginAPI.Hooks.CURRENT_TASK_CHANGE, (payload) => {
    lastCurrentTaskId = payload.current ? payload.current.id : null;
    markColorRefreshDirty();
  });

  PluginAPI.registerHook(PluginAPI.Hooks.ANY_TASK_UPDATE, async () => {
    PluginAPI.log.info('[TaskColor] ANY_TASK_UPDATE fired');
    await loadTagColors();
    markColorRefreshDirty();
  });

  PluginAPI.registerHook(PluginAPI.Hooks.PERSISTED_DATA_CHANGED, async () => {
    await loadTaskColors();
    markColorRefreshDirty();
  });

  PluginAPI.registerHeaderButton({
    label: 'Task Color',
    icon: 'palette',
    onClick: handleColorAction
  });

  PluginAPI.registerShortcut({
    id: 'task-color-shortcut',
    label: 'Pick color for current task',
    keys: 'ctrl+shift+p',
    onExec: handleColorAction
  });

  startParentObserver();
  setTimeout(refreshParentColors, 1000);

  // Expose a global function for iframe-side direct calls as a fallback
  window.taskColorPluginHost = {
    openTagColors: async () => {
      PluginAPI.log.info('[TaskColor] Host received direct openTagColors call');
      return openHostTagColorsDialog(null);
    }
  };

  // Listen for tag colors requests/results from iframe
  window.addEventListener('message', async (event) => {
    PluginAPI.log.info('[TaskColor] Host received message');
    if (event.data && event.data.type === 'open-tag-colors') {
      try {
        PluginAPI.log.info('[TaskColor] Host received open-tag-colors request');
        const result = await openHostTagColorsDialog(event);
        if (result && event.source) {
          event.source.postMessage({ type: 'tag-colors-result', colors: result }, event.origin);
        }
      } catch (error) {
        console.error('[TaskColor] Host error with tag colors:', error);
        PluginAPI.showSnack({ msg: 'Failed to open tag colors: ' + error.message, type: 'ERROR' });
        if (event.source) {
          event.source.postMessage({ type: 'tag-colors-result', colors: {} }, event.origin);
        }
      }
    } else if (event.data && event.data.type === 'tag-colors-result') {
      // Iframe-side dialog saved tag colors; reload and refresh
      try {
        PluginAPI.log.info('[TaskColor] Host received tag-colors-result from iframe');
        const saved = await PluginAPI.loadSyncedData('tagColors');
        tagColors = saved ? JSON.parse(saved) : {};
        markColorRefreshDirty();
      } catch (e) {
        console.error('[TaskColor] Failed to reload tag colors from iframe result:', e);
      }
    }
  });
}

async function openHostTagColorsDialog(event) {
  const tags = await PluginAPI.getAllTags();
  const saved = await PluginAPI.loadSyncedData('tagColors');
  const currentTagColors = saved ? JSON.parse(saved) : {};

  if (!tags || tags.length === 0) {
    PluginAPI.showSnack({ msg: 'No tags found', type: 'WARNING' });
    if (event && event.source) {
      event.source.postMessage({ type: 'tag-colors-result', colors: {} }, event.origin);
    }
    return {};
  }

  const rowsHtml = tags.map(tag => {
    const defaultColor = tag.color || '#000000';
    const pluginColor = currentTagColors[tag.id] || defaultColor;
    const isActive = currentTagColors[tag.id] !== undefined;
    return '<div class="tag-color-row" data-tag-id="' + tag.id + '" data-tag-title="' + escapeHtml(tag.title).toLowerCase() + '">' +
      '<label class="tag-color-checkbox-label">' +
        '<input type="checkbox" class="tag-color-active" data-tag-id="' + tag.id + '" ' + (isActive ? 'checked' : '') + '>' +
        '<span class="tag-name" title="' + escapeHtml(tag.title) + '">' + escapeHtml(tag.title) + '</span>' +
      '</label>' +
      '<input type="color" class="tag-color-input" data-tag-id="' + tag.id + '" value="' + pluginColor + '" ' + (isActive ? '' : 'disabled') + '>' +
      '</div>';
  }).join('');

  const searchHtml = '<input type="text" id="tagSearchInput" placeholder="Search tags..." style="width:100%;padding:8px;margin-bottom:8px;border:1px solid var(--divider-color);border-radius:var(--card-border-radius);background:var(--card-bg);color:var(--text-color);">';

  const result = await PluginAPI.openDialog({
    title: 'Tag Colors (' + tags.length + ' tags)',
    htmlContent: '<div style="padding:8px 0;max-height:60vh;overflow-y:auto;">' + searchHtml + rowsHtml + '</div>',
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Save',
        color: 'primary',
        raised: true,
        onClick: async () => {
          try {
            const inputs = document.querySelectorAll('.tag-color-input');
            const checkboxes = document.querySelectorAll('.tag-color-active');
            const newTagColors = {};
            
            inputs.forEach((input, index) => {
              const tagId = input.dataset.tagId;
              const isActive = checkboxes[index] && checkboxes[index].checked;
              if (isActive) {
                newTagColors[tagId] = input.value;
              }
            });
            
            await PluginAPI.persistDataSynced(JSON.stringify(newTagColors), 'tagColors');
            
            // Update tag colors in tag settings
            for (const [tagId, color] of Object.entries(newTagColors)) {
              await PluginAPI.updateTag(tagId, { color });
            }
            
            PluginAPI.showSnack({ msg: 'Tag colors saved', type: 'SUCCESS' });
            
            // Update local state and refresh colors immediately
            tagColors = newTagColors;
            markColorRefreshDirty();
            
            PluginAPI.log.info('[TaskColor] Host saved tag colors');
            return newTagColors;
          } catch (e) {
            PluginAPI.showSnack({ msg: 'Error saving: ' + e.message, type: 'ERROR' });
            return {};
          }
        }
      }
    ]
  });
  
  // Add search/filter functionality
  const searchInput = document.getElementById('tagSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      const rows = document.querySelectorAll('.tag-color-row');
      rows.forEach(row => {
        const title = row.getAttribute('data-tag-title') || '';
        const tagName = row.querySelector('.tag-name')?.textContent?.toLowerCase() || '';
        if (!query || title.includes(query) || tagName.includes(query)) {
          row.style.display = '';
        } else {
          row.style.display = 'none';
        }
      });
    });
  }
  
  return result || {};
}

async function init() {
  try {
    await loadTagColors();
    await loadTaskColors();
    await loadFavorites();
    register();
  } catch (e) {
    console.error('Task Color plugin init failed:', e);
  }
}

if (typeof plugin !== 'undefined' && plugin.onReady) {
  plugin.onReady(init);
} else if (PluginAPI.onReady) {
  PluginAPI.onReady(init);
} else {
  init();
}
