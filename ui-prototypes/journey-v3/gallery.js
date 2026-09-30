(() => {
  'use strict';
  const screens = window.JOURNEY_DATA;
  const byId = new Map(screens.map(screen => [screen.id, screen]));
  const $ = id => document.getElementById(id);
  const dialog = $('simulation-dialog');
  let current = screens[0];
  let dialogTrigger;

  const branches = {
    welcome: [['Existing connection', 'projects']],
    signin: [['Existing connection', 'projects']],
    browser: [['Cancel sign-in', 'signin'], ['Retry browser handoff', '@browserRetry']],
    connected: [['Different account', 'signin']],
    projects: [['Open a folder…', 'folder']],
    folder: [['Cancel', 'projects']],
    workspace: [['Project library', 'projects'], ['Agent at work', 'working']],
    symbols: [['New conversation', 'workspace']],
    approval: [['Close review', '@closeReview'], ['Deny', '@deny']],
    working: [['Preview Code', 'symbols'], ['Queue a follow-up', '@queue']],
    changes: [['Preview Code', 'symbols']],
    sessions: [['Inspect changes', 'changes']]
  };

  const explanations = {
    browserRetry: {
      title: 'Reopen the system browser',
      body: 'The app would reopen its pending sign-in request in your browser. This prototype stays here; use “Simulate authorized return” after closing this explanation to preview a successful connection.',
      actions: [['Stay on this screen', null]]
    },
    usage: {
      title: 'Manage ChatGPT usage',
      body: 'The finished app should provide access to the account’s usage controls beside its connection status. This example assumes plan permission was granted. Viewing this concept does not connect an account or consume plan usage.',
      actions: [['Back to the journey', null]]
    },
    account: {
      title: 'Account and connection',
      body: 'A persistent Account destination keeps connection status, plan permission, and usage controls separate from project navigation. This screen is an illustrative connected state, not a live account.',
      actions: [['Preview sign-in', 'signin'], ['Keep exploring', null]]
    },
    outline: {
      title: 'Navigate a symbol in the active file',
      body: 'Selecting build() would scroll the right-hand read-only preview to that method while the central conversation stays in place. Files represent the folder hierarchy; Outline represents symbols in the active file. This prototype explains that interaction without moving the code image.',
      actions: [['Back to the file', null]]
    },
    deny: {
      title: 'Operation denied',
      body: 'In the proposed flow, Deny resolves this one request without running its command. The conversation records the decision, and LUMI can offer another approach. No operation runs in this prototype.',
      actions: [['Return to the conversation', 'symbols']]
    },
    closeReview: {
      title: 'Review closed, decision still pending',
      body: 'Closing the review does not authorize or deny the operation. The request remains waiting and can be reopened from its conversation entry. This image walkthrough keeps the pending review available.',
      actions: [['Inspect code context', 'symbols'], ['Reopen review', null]]
    },
    queue: {
      title: 'Follow up while LUMI works',
      body: 'Queue keeps the current work running and adds your instruction to the next available turn. The center composer stays available throughout. This is a simulation; no instruction is submitted.',
      actions: [['Keep following progress', null], ['Preview the result', 'changes']]
    },
    stopSend: {
      title: 'Stop, then send the new instruction',
      body: 'Stop & Send requests cancellation, waits for confirmed terminal outcomes, and only then submits the follow-up. If stopping is uncertain, keep the draft and explain the state instead of claiming the instruction was sent. This prototype runs neither action.',
      actions: [['Back to the conversation', null]]
    },
    stop: {
      title: 'Keep stopping visible in the conversation',
      body: 'The Stop control should become Cancelling until the runtime confirms the outcome. Keep existing edits and the user’s draft visible. This walkthrough does not run or cancel a task.',
      actions: [['Back to the conversation', null]]
    },
    activity: {
      title: 'Observable activity, on demand',
      body: 'The compact chat entry can expand to show recorded file reads and tool output. The right walkthrough summarizes which step is done, active, waiting, or upcoming. It describes observable work, not the agent’s private reasoning.',
      actions: [['Preview code context', 'symbols'], ['Back to progress', null]]
    },
    diff: {
      title: 'Supporting evidence beside the conversation',
      body: 'The right Changes panel names the comparison baseline and lets the user inspect file differences. Working-tree changes may include earlier or external edits; they are not proof that every displayed line belongs to this task. The preview is read-only.',
      actions: [['Back to the result', null]]
    },
    checks: {
      title: 'Ask for evidence explicitly',
      body: 'Sending this follow-up would request the relevant checks. A completed coding turn does not imply those checks ran or passed. This concept stops before executing anything and continues to label them “Checks not run”.',
      actions: [['Back to the result', null], ['View the saved conversation', 'sessions']]
    },
    followup: {
      title: 'Continue the conversation deliberately',
      body: 'Selecting an old conversation loads its recorded messages and task evidence. Execution begins only after the user sends a new instruction; opening history never silently resumes a run.',
      actions: [['Preview a new conversation', 'workspace'], ['Keep reading', null]]
    },
    output: {
      title: 'Recorded session evidence',
      body: 'An example of the evidence attached to a recorded run. Opening a session is read-only and does not resume execution.',
      output: 'Sample session: Refine sidebar spacing\nRun: Finished\nChanges: 2 files\nChecks: Not run\nReview: Not reviewed\n\nThe file and command content in these concepts is illustrative.',
      actions: [['Inspect the changes', 'changes'], ['Back to sessions', null]]
    },
    authFailed: {
      title: 'Sign-in was interrupted',
      body: 'Keep the user on the connection screen with a clear retry action. Do not store a successful connection or display plan access until the browser callback has been verified. Cancellation should return to the sign-in entry without an error alarm.',
      actions: [['Preview retry', 'signin'], ['Close explanation', null]]
    },
    identityOnly: {
      title: 'Connected without plan permission',
      body: 'Identity verification and permission to use a ChatGPT plan are separate. If plan access is declined, show that distinction and offer to request permission again. Do not display “Using ChatGPT plan” or enable plan-backed tasks on the strength of identity alone.',
      actions: [['Preview connection entry', 'signin'], ['Close explanation', null]]
    },
    noProjects: {
      title: 'Your first project',
      body: 'The empty project library should explain that opening a folder keeps the files in their current location. Offer one clear “Open existing workspace” action; populate Recent after a folder has opened successfully. Pinned projects are a proposed addition.',
      actions: [['Preview the folder picker', 'folder'], ['Close explanation', null]]
    },
    missingFolder: {
      title: 'This project folder is unavailable',
      body: 'Preserve the recent project’s name and last-known path so it remains recognizable. Offer to locate its folder again or return to projects. Do not silently open another path, create a replacement folder, or remove the recent entry.',
      actions: [['Locate folder', 'folder'], ['Back to projects', 'projects']]
    }
  };

  function navigate(id) {
    if (!byId.has(id)) return;
    if (location.hash === '#' + id) render(id);
    else location.hash = id;
  }

  function act(target, trigger) {
    if (target.startsWith('@')) showExplanation(target.slice(1), trigger);
    else navigate(target);
  }

  function button(label, target, className) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    if (className) node.className = className;
    node.addEventListener('click', () => act(target, node));
    return node;
  }

  function showExplanation(id, trigger) {
    const state = explanations[id];
    if (!state) return;
    dialogTrigger = trigger;
    $('dialog-title').textContent = state.title;
    $('dialog-body').textContent = state.body;
    $('dialog-output').hidden = !state.output;
    $('dialog-output').textContent = state.output || '';
    $('dialog-actions').replaceChildren();
    for (const [label, target] of state.actions) {
      const action = document.createElement('button');
      action.type = 'button';
      action.textContent = label;
      action.addEventListener('click', () => {
        dialog.close();
        if (target) navigate(target);
      });
      $('dialog-actions').append(action);
    }
    dialog.showModal();
  }

  function render(id) {
    current = byId.get(id) || screens[0];
    const index = screens.indexOf(current);
    document.title = current.title + ' · HEAV3NS-CODE journey';
    $('screen-title').textContent = current.title;
    $('screen-goal').textContent = current.goal;
    $('screen-detail').textContent = current.detail;
    $('count').textContent = (index + 1) + ' / ' + screens.length;
    $('phase').textContent = current.phase;
    $('full-size').href = current.file;
    $('prompt-link').href = current.prompt;
    $('screen-image').alt = 'Generated ' + current.title.toLowerCase() + ' concept for HEAV3NS-CODE. ' + current.goal + ' ' + current.detail;
    $('screen-image').src = current.file;
    $('primary').textContent = current.action;
    $('primary').classList.toggle('primary', current.id !== 'approval');
    $('previous').disabled = index === 0;
    $('branches').replaceChildren(...(branches[current.id] || []).map(([label, target]) => button(label, target)));
    for (const link of $('steps').querySelectorAll('a')) {
      if (link.hash === '#' + current.id) link.setAttribute('aria-current', 'step');
      else link.removeAttribute('aria-current');
    }
    if (window.matchMedia('(max-width: 760px)').matches) {
      const selected = $('steps').querySelector('[aria-current="step"]');
      $('steps').scrollLeft += selected.getBoundingClientRect().left - $('steps').getBoundingClientRect().left - ($('steps').clientWidth - selected.clientWidth) / 2;
    }
    $('hotspots').replaceChildren();
    for (const hotspot of current.hotspots) {
      const node = button('', hotspot.to, 'hotspot');
      node.setAttribute('aria-label', hotspot.label);
      node.style.left = hotspot.x + '%';
      node.style.top = hotspot.y + '%';
      node.style.width = hotspot.w + '%';
      node.style.height = hotspot.h + '%';
      const tip = document.createElement('span');
      tip.className = 'tip';
      tip.setAttribute('aria-hidden', 'true');
      tip.textContent = hotspot.label;
      node.append(tip);
      $('hotspots').append(node);
    }
    $('feedback').textContent = 'Screen ' + (index + 1) + ' of ' + screens.length + ': ' + current.title + '. Example state; all actions are simulated.';
  }

  let phase;
  for (const screen of screens) {
    if (screen.phase !== phase) {
      phase = screen.phase;
      const heading = document.createElement('p');
      heading.className = 'phase-heading';
      heading.textContent = phase;
      $('steps').append(heading);
    }
    const link = document.createElement('a');
    link.className = 'step';
    link.href = '#' + screen.id;
    const number = document.createElement('span');
    number.className = 'step-num';
    number.textContent = String(screen.n).padStart(2, '0');
    const label = document.createElement('span');
    label.textContent = screen.title;
    link.append(number, label);
    $('steps').append(link);
  }

  $('primary').addEventListener('click', () => navigate(current.next));
  $('previous').addEventListener('click', () => navigate(screens[Math.max(0, screens.indexOf(current) - 1)].id));
  $('toggle-hotspots').addEventListener('click', () => {
    const show = !$('stage').classList.contains('show-hotspots');
    $('stage').classList.toggle('show-hotspots', show);
    $('toggle-hotspots').setAttribute('aria-pressed', String(show));
    $('toggle-hotspots').textContent = show ? 'Hide hotspots' : 'Show hotspots';
  });
  document.querySelectorAll('[data-go]').forEach(node => node.addEventListener('click', () => navigate(node.dataset.go)));
  document.querySelectorAll('[data-dialog]').forEach(node => node.addEventListener('click', () => showExplanation(node.dataset.dialog, node)));
  dialog.addEventListener('close', () => { if (dialogTrigger?.isConnected) dialogTrigger.focus({preventScroll: true}); });
  window.addEventListener('hashchange', () => {
    if (dialog.open) dialog.close();
    render(location.hash.slice(1));
  });
  render(location.hash.slice(1) || 'working');
})();
