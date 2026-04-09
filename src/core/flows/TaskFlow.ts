import path from 'path';
import fs from 'fs';

import { resolveGroupIpcPath } from '../utils/index.js';
import { RegisteredGroup, ScheduledTask } from '../repositories/index.js';

export interface TaskFlow {
  writeTasksSnapshotIntoFile: (folder: string, isMain: boolean, taskRows: SnapshotTaskRow[]) => void;
  onTasksChangedFor: (group: RegisteredGroup) => void;
  onTasksChanged: () => void;
}

export interface SnapshotTaskRow {
  id: string;
  groupFolder: string;
  prompt: string;
  script?: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  status: 'active' | 'paused' | 'completed';
  next_run?: string;
}

interface TasksFlowDeps {
  getAllScheduledTasks: () => ScheduledTask[];
  getAllRegisteredGroupsAsRecord: () => Record<string, RegisteredGroup>;
}

export const createTaskFlow = (deps: TasksFlowDeps): TaskFlow => {
  const writeTasksSnapshotIntoFile = (folder: string, isMain: boolean, taskRows: SnapshotTaskRow[]) => {
    // Write filtered tasks to the group's IPC directory
    const groupIpcDir = resolveGroupIpcPath(folder);
    fs.mkdirSync(groupIpcDir, { recursive: true });

    // Main sees all tasks, others only see their own
    const filteredTasks = isMain ? taskRows : taskRows.filter((t) => t.groupFolder === folder);

    const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
  };

  return {
    writeTasksSnapshotIntoFile: (folder, isMain, taskRows) => writeTasksSnapshotIntoFile(folder, isMain, taskRows),

    onTasksChangedFor: (group) => {
      const tasks = deps.getAllScheduledTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.groupFolder,
        prompt: t.prompt,
        script: t.script ?? undefined,
        schedule_type: t.scheduleType,
        schedule_value: t.scheduleValue,
        status: t.status,
        next_run: t.nextRun,
      }));
      writeTasksSnapshotIntoFile(group.folder, group.isMain, taskRows);
    },

    onTasksChanged: () => {
      const tasks = deps.getAllScheduledTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.groupFolder,
        prompt: t.prompt,
        script: t.script ?? undefined,
        schedule_type: t.scheduleType,
        schedule_value: t.scheduleValue,
        status: t.status,
        next_run: t.nextRun,
      }));
      const registeredGroups = deps.getAllRegisteredGroupsAsRecord();
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshotIntoFile(group.folder, group.isMain === true, taskRows);
      }
    },
  };
};
