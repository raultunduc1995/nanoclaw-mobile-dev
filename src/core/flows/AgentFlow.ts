import path from 'path';
import fs from 'fs';

import { AvailableGroup } from '../repositories/index.js';
import { resolveGroupIpcPath } from '../utils/index.js';

export interface AgentFlow {
  writeAvailableGroupsIn: (groupFolder: string, groups: AvailableGroup[], isMain: boolean) => void;
}

export const createAgentFlow = (): AgentFlow => {
  const writeAvailableGroupsIn = (groupFolder: string, groups: AvailableGroup[], isMain: boolean): void => {
    const groupIpcDir = resolveGroupIpcPath(groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });

    // Main sees all groups; others see nothing (they can't activate groups)
    const visibleGroups = isMain ? groups : [];

    const groupsFile = path.join(groupIpcDir, 'available_groups.json');
    fs.writeFileSync(
      groupsFile,
      JSON.stringify(
        {
          groups: visibleGroups,
          lastSync: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  };

  return {
    writeAvailableGroupsIn: writeAvailableGroupsIn,
  };
};
