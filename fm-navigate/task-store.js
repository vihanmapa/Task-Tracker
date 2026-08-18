/* ============================================================
   FM Navigate — normalized task store + client scope mirror
   ------------------------------------------------------------
   Phase 3 (docs/TDD-PERSONAL-TASK-WORKSPACES.md). Two things live here:

   1. window.taskStore — the mapping/diffing half of the normalized task
      path. It turns table rows into the EXACT task object shape the whole
      UI already consumes (tasks.jsx, dashboard.jsx, weekly.jsx, exports…),
      and turns a changed in-memory task list back into row writes. So the
      storage model changed from "one jsonb document" to "six tables" with
      no rewrite of any feature module. dataService does the I/O; this file
      is pure and unit-testable.

   2. window.taskScope — a MIRROR of the SQL predicates task_read_ok /
      task_write_ok, used to shape the UI (what to render, what to enable).
      It is NOT the security boundary: the database evaluates the same rules
      on every request, and a tampered client is simply refused. Keeping the
      mirror in one place is what stops it drifting from the policies —
      scripts/verify-auth-bootstrap.mjs checks both against one truth table.

   BACKWARD COMPATIBILITY: `ownerId` stays on every task object as an alias
   of the assignee, because ~40 call sites read it. `reporterId` is added
   alongside. The database has the clean two-column model; the UI keeps its
   vocabulary. (TDD §7, decision D3.)
   ============================================================ */
(function () {
  'use strict';

  /* ---------- row → task object ---------- */

  function num(v, dflt) { var n = Number(v); return Number.isFinite(n) ? n : dflt; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function iso(v) { return v ? new Date(v).toISOString() : null; }

  function rowToTask(row) {
    return {
      id: row.id,
      title: row.title || '',
      description: row.description || '',
      status: row.status || 'Not Started',
      priority: row.priority || 'Medium',
      category: row.category || null,
      effort: row.effort || 'M',
      progress: num(row.progress, 0),
      dueDate: iso(row.due_date),
      completedAt: iso(row.completed_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      deliverableId: row.deliverable_id || null,
      successCriteria: row.success_criteria || '',
      risk: row.risk || '',
      dependencies: arr(row.dependencies),
      depTaskIds: arr(row.dep_task_ids),
      edits: arr(row.edits),
      // Reporter / assignee are the real model; ownerId is the legacy alias.
      reporterId: row.reporter_id || null,
      assigneeId: row.assignee_id || null,
      ownerId: row.assignee_id || row.legacy_owner || null,
      organizationId: row.organization_id || null,
      legacyOwner: row.legacy_owner || null,
      // filled in by hydrate()
      checklist: [], progressLog: [], resources: [], comments: [], activity: [],
    };
  }

  function checklistFromRow(r) {
    return {
      id: r.id, title: r.title || '', note: r.note || undefined,
      done: !!r.done, links: arr(r.links), files: arr(r.files),
      completedAt: iso(r.completed_at), completedBy: r.completed_by || null,
      completedInLogId: r.completed_in_log_id || null,
    };
  }
  function progressFromRow(r) {
    return {
      id: r.id, percent: num(r.percent, 0), status: r.status || null, note: r.note || '',
      links: arr(r.links), files: arr(r.files), checklistIds: arr(r.checklist_ids),
      userId: r.user_id || null, at: iso(r.at), editedAt: iso(r.edited_at) || undefined,
    };
  }
  function resourceFromRow(r) {
    return { id: r.id, kind: r.kind || 'link', title: r.title || '', url: r.url || '', note: r.note || '' };
  }
  function commentFromRow(r) {
    return { id: r.id, userId: r.user_id || null, comment: r.body || '', createdAt: iso(r.created_at) };
  }
  function activityFromRow(r) {
    return { type: r.type, userId: r.user_id || null, at: iso(r.at), detail: r.detail || undefined };
  }

  /* Assemble the rows returned by dataService.loadTaskRows() into task
     objects. Children are grouped in one pass (not one filter per task), so
     this stays linear on a workspace of any size. */
  function hydrate(payload) {
    var byId = {};
    var tasks = (payload.tasks || []).map(function (r) {
      var t = rowToTask(r);
      byId[t.id] = t;
      return t;
    });
    var group = function (rows, field, map) {
      (rows || []).forEach(function (r) {
        var t = byId[r.task_id];
        if (t) t[field].push(map(r));
      });
    };
    // Checklist order is the user's own ordering, stored as sort_order.
    (payload.checklist || []).slice()
      .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); })
      .forEach(function (r) { var t = byId[r.task_id]; if (t) t.checklist.push(checklistFromRow(r)); });
    group(payload.progress, 'progressLog', progressFromRow);
    group(payload.resources, 'resources', resourceFromRow);
    group(payload.comments, 'comments', commentFromRow);
    // Activity is ordered by its stored sequence, which is the order the
    // events actually happened in — never by insertion order of the read.
    (payload.activity || []).slice()
      .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); })
      .forEach(function (r) { var t = byId[r.task_id]; if (t) t.activity.push(activityFromRow(r)); });

    tasks.forEach(function (t) {
      t.progressLog.sort(function (a, b) { return new Date(a.at || 0) - new Date(b.at || 0); });
      t.comments.sort(function (a, b) { return new Date(a.createdAt || 0) - new Date(b.createdAt || 0); });
    });
    return tasks;
  }

  /* ---------- task object → rows ---------- */

  // Only the columns a client may set. organization/reporter/created_by are
  // insert-only (the DB trigger rejects changing them), and updated_at /
  // updated_by are stamped server-side — sending them would be a lie.
  var MUTABLE_COLUMNS = {
    title: 'title', description: 'description', status: 'status', priority: 'priority',
    category: 'category', effort: 'effort', progress: 'progress',
    dueDate: 'due_date', completedAt: 'completed_at',
    deliverableId: 'deliverable_id', successCriteria: 'success_criteria', risk: 'risk',
    dependencies: 'dependencies', depTaskIds: 'dep_task_ids', edits: 'edits',
    ownerId: 'assignee_id',
  };

  function columnValue(task, field) {
    var v = task[field];
    if (field === 'ownerId') {
      // A legacy (non-uuid) owner key has no account to point at; the column
      // stays null and the key is preserved in legacy_owner instead.
      return isUuid(v) ? v : null;
    }
    if (field === 'progress') return num(v, 0);
    if (field === 'dependencies' || field === 'depTaskIds' || field === 'edits') return arr(v);
    if (field === 'dueDate' || field === 'completedAt') return v || null;
    return v === undefined ? null : v;
  }

  function isUuid(v) {
    return typeof v === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  }

  function insertRow(task, ctx) {
    var row = { id: task.id, organization_id: ctx.organizationId };
    Object.keys(MUTABLE_COLUMNS).forEach(function (f) { row[MUTABLE_COLUMNS[f]] = columnValue(task, f); });
    // Reporter is who RAISED it — the signed-in user, always, at insert time.
    // The DB re-checks this (WITH CHECK reporter_id = auth.uid()), so a forged
    // value here is refused rather than trusted.
    row.reporter_id = isUuid(task.reporterId) ? task.reporterId : ctx.userId;
    row.created_by = ctx.userId;
    row.updated_by = ctx.userId;
    if (row.assignee_id == null && !isUuid(task.ownerId) && task.ownerId) row.legacy_owner = task.ownerId;
    row.created_at = task.createdAt || new Date().toISOString();
    return row;
  }

  var CHILD_SPEC = {
    checklist: {
      field: 'checklist',
      row: function (c, taskId, i) {
        return {
          id: c.id, task_id: taskId, title: c.title || '', note: c.note || null,
          done: !!c.done, links: arr(c.links), files: arr(c.files),
          completed_at: c.completedAt || null,
          completed_by: isUuid(c.completedBy) ? c.completedBy : null,
          completed_in_log_id: c.completedInLogId || null,
          sort_order: i,
        };
      },
    },
    progress: {
      field: 'progressLog',
      row: function (p, taskId, i, ctx) {
        return {
          id: p.id, task_id: taskId, percent: num(p.percent, 0), status: p.status || null,
          note: p.note || null, links: arr(p.links), files: arr(p.files),
          checklist_ids: arr(p.checklistIds),
          user_id: isUuid(p.userId) ? p.userId : ctx.userId,
          at: p.at || new Date().toISOString(),
          edited_at: p.editedAt || null,
        };
      },
    },
    resources: {
      field: 'resources',
      row: function (r, taskId) {
        return { id: r.id, task_id: taskId, kind: r.kind || 'link', title: r.title || null, url: r.url || null, note: r.note || null };
      },
    },
    comments: {
      field: 'comments',
      row: function (k, taskId, i, ctx) {
        return {
          id: k.id, task_id: taskId, user_id: isUuid(k.userId) ? k.userId : ctx.userId,
          body: k.comment || '', created_at: k.createdAt || new Date().toISOString(),
        };
      },
    },
  };

  function activityRows(task, fromIndex, ctx) {
    return arr(task.activity).slice(fromIndex).map(function (a, i) {
      return {
        task_id: task.id, seq: fromIndex + i, type: a.type || 'edit',
        user_id: isUuid(a.userId) ? a.userId : ctx.userId,
        at: a.at || new Date().toISOString(), detail: a.detail || null,
      };
    });
  }

  /* ---------- diffing ---------- */

  function byId(list) {
    var m = {};
    (list || []).forEach(function (t) { if (t && t.id) m[t.id] = t; });
    return m;
  }
  var same = function (a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); };

  // Which columns actually changed. Sending only these keeps the governance
  // trigger honest: an edit that never touches `priority` can't trip the
  // tasks.prioritize check just because the field rode along unchanged.
  function changedColumns(prev, next) {
    var patch = {};
    Object.keys(MUTABLE_COLUMNS).forEach(function (f) {
      var a = columnValue(prev, f), b = columnValue(next, f);
      if (!same(a, b)) patch[MUTABLE_COLUMNS[f]] = b;
    });
    return patch;
  }

  function childOps(prevTask, nextTask, kind, ctx) {
    var spec = CHILD_SPEC[kind];
    var prevList = arr(prevTask && prevTask[spec.field]);
    var nextList = arr(nextTask[spec.field]);
    var prevMap = {};
    prevList.forEach(function (x, i) { if (x && x.id) prevMap[x.id] = spec.row(x, nextTask.id, i, ctx); });
    var upsert = [];
    var seen = {};
    nextList.forEach(function (x, i) {
      if (!x || !x.id) return;
      seen[x.id] = true;
      var row = spec.row(x, nextTask.id, i, ctx);
      if (!same(prevMap[x.id], row)) upsert.push(row);
    });
    var remove = Object.keys(prevMap).filter(function (id) { return !seen[id]; });
    return { upsert: upsert, remove: remove };
  }

  /* Everything that must be written to turn `prev` into `next`. Returned as
     data (not executed) so it can be inspected in tests and logged on
     failure. */
  function plan(prevTasks, nextTasks, ctx) {
    var p = byId(prevTasks), n = byId(nextTasks);
    var creates = [], updates = [], deletes = [], children = [], activity = [];

    (nextTasks || []).forEach(function (task) {
      if (!task || !task.id) return;
      var before = p[task.id];
      if (!before) {
        creates.push(insertRow(task, ctx));
        Object.keys(CHILD_SPEC).forEach(function (kind) {
          var ops = childOps(null, task, kind, ctx);
          if (ops.upsert.length) children.push({ kind: kind, upsert: ops.upsert, remove: [] });
        });
        activity = activity.concat(activityRows(task, 0, ctx));
        return;
      }
      var patch = changedColumns(before, task);
      if (Object.keys(patch).length) updates.push({ id: task.id, patch: patch });
      Object.keys(CHILD_SPEC).forEach(function (kind) {
        var ops = childOps(before, task, kind, ctx);
        if (ops.upsert.length || ops.remove.length) children.push({ kind: kind, upsert: ops.upsert, remove: ops.remove });
      });
      // The activity feed is append-only, so only entries beyond the ones we
      // already know about are sent (the table has no UPDATE policy at all).
      var known = arr(before.activity).length;
      if (arr(task.activity).length > known) activity = activity.concat(activityRows(task, known, ctx));
    });

    Object.keys(p).forEach(function (id) { if (!n[id]) deletes.push(id); });
    return { creates: creates, updates: updates, deletes: deletes, children: children, activity: activity };
  }

  function isEmptyPlan(pl) {
    return !pl.creates.length && !pl.updates.length && !pl.deletes.length &&
           !pl.children.length && !pl.activity.length;
  }

  /* Execute a plan. Order matters: task rows first (children have an FK to
     them), deletes last (their children cascade). Every failure is collected
     rather than thrown, so one rejected write — e.g. RLS refusing a field the
     UI mistakenly offered — is reported honestly instead of silently losing
     the rest of the batch. */
  function persist(ds, prevTasks, nextTasks, ctx) {
    var pl = plan(prevTasks, nextTasks, ctx);
    if (isEmptyPlan(pl)) return Promise.resolve({ ok: true, plan: pl, errors: [] });
    var errors = [];
    var note = function (what) {
      return function (r) { if (r && !r.ok) errors.push(what + ': ' + (r.error || 'refused')); return r; };
    };

    return Promise.all(pl.creates.map(function (row) {
      return ds.insertTaskRow(row).then(note('create ' + row.id));
    })).then(function () {
      return Promise.all(pl.updates.map(function (u) {
        return ds.updateTaskRow(u.id, u.patch).then(note('update ' + u.id));
      }));
    }).then(function () {
      return Promise.all(pl.children.map(function (c) {
        return ds.upsertChildRows(c.kind, c.upsert).then(note(c.kind))
          .then(function () { return ds.deleteChildRows(c.kind, c.remove).then(note(c.kind + ' remove')); });
      }));
    }).then(function () {
      return ds.appendActivityRows(pl.activity).then(note('activity'));
    }).then(function () {
      return Promise.all(pl.deletes.map(function (id) {
        return ds.deleteTaskRow(id).then(note('delete ' + id));
      }));
    }).then(function () {
      return { ok: errors.length === 0, plan: pl, errors: errors };
    });
  }

  window.taskStore = {
    hydrate: hydrate,
    rowToTask: rowToTask,
    insertRow: insertRow,
    changedColumns: changedColumns,
    plan: plan,
    persist: persist,
    isUuid: isUuid,
    MUTABLE_COLUMNS: MUTABLE_COLUMNS,
  };

  /* ============================================================
     window.taskScope — the client mirror of the SQL predicates.
     ============================================================
     ctx = {
       userId,        the signed-in profile id
       canRead,       tasks.read
       canExecute,    tasks.execute
       canCreate,     tasks.create
       canViewAll,    tasks.view_all   ← management scope
       canAssign,     tasks.assign
       canPrioritize, tasks.prioritize
       canDelete,     tasks.delete
       canGovern,     admin.workspace  (governance surfaces)
     }
     Mirrors supabase/schema.sql §3.3 exactly. UI shaping only. */

  function relatedToMe(task, ctx) {
    if (!task || !ctx) return false;
    var me = ctx.userId;
    return !!me && (task.assigneeId === me || task.ownerId === me || task.reporterId === me);
  }

  var taskScope = {
    // "is this task mine?" — assignee OR reporter, the two object relationships
    // that make a task yours. Management scope is deliberately NOT folded in
    // here: seeing everything is not the same as owning something.
    isMine: relatedToMe,

    canRead: function (task, ctx) {
      return !!ctx && !!ctx.canRead && (relatedToMe(task, ctx) || !!ctx.canViewAll);
    },
    canWrite: function (task, ctx) {
      return !!ctx && !!ctx.canExecute && (relatedToMe(task, ctx) || !!ctx.canViewAll);
    },
    // Creating for yourself needs only tasks.create; creating for somebody
    // else is the assignment capability.
    canCreateFor: function (assigneeId, ctx) {
      if (!ctx || !ctx.canCreate) return false;
      return !assigneeId || assigneeId === ctx.userId || !!ctx.canAssign;
    },
    canDelete: function (task, ctx) {
      return !!ctx && !!ctx.canDelete && (relatedToMe(task, ctx) || !!ctx.canViewAll);
    },
    // Per-field rules, matching protect_task_governance().
    fieldAllowed: function (task, field, ctx) {
      if (!ctx) return false;
      if (field === 'ownerId' || field === 'assigneeId') return !!ctx.canAssign;
      if (field === 'priority') return !!ctx.canPrioritize;
      if (field === 'reporterId') return false;              // immutable
      return taskScope.canWrite(task, ctx) || !!ctx.canGovern;
    },
    // Defence in depth for rendering. In normalized mode RLS has already
    // filtered these rows, so this is presentation; in the legacy workspace
    // fallback it is the ONLY scoping there is — which is exactly why the
    // fallback is not the secure path and normalisation exists.
    visible: function (tasks, ctx) {
      if (!ctx) return [];
      if (ctx.canViewAll) return tasks || [];
      return (tasks || []).filter(function (t) { return relatedToMe(t, ctx); });
    },
    // Assigned to me — the backbone of every personal widget. Reported-by-me
    // tasks are deliberately NOT included: delegating work should take it off
    // your own list while keeping it visible to you elsewhere.
    mine: function (tasks, ctx) {
      if (!ctx || !ctx.userId) return [];
      return (tasks || []).filter(function (t) {
        return t.assigneeId === ctx.userId || (t.assigneeId == null && t.ownerId === ctx.userId);
      });
    },
  };

  window.taskScope = taskScope;
})();
