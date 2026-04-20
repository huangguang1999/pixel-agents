export type Lang = 'zh' | 'en';

export interface Strings {
  // MockEventPanel
  panelTitle: string;
  panelAdd: string;
  panelEmpty: string;
  panelAgents: (n: number) => string;
  panelTools: string;
  panelActions: string;
  panelNotify: string;
  panelWaiting: string;
  panelIdle: string;
  panelWalkPrefix: string;
  panelLog: string;
  logPanelTitle: string;
  logPanelEmpty: string;
  stateIdle: string;
  stateActive: string;
  bubblePermission: string;
  bubbleWaiting: string;
  // Walk targets
  targetDoor: string;
  targetWhiteboard: string;
  targetBookshelfL: string;
  targetBookshelfR: string;
  targetWaterCooler: string;
  targetPantryCoffee: string;
  targetSofaCoffee: string;
  targetMeeting: string;
  targetBin: string;
  // Legend panel
  legendTitle: string;
  legendClose: string;
  legendOpen: string;
  legendHookCol: string;
  legendActionCol: string;
  legendFurnitureCol: string;
  legendRows: Array<{ hook: string; action: string; furniture: string }>;
  // Floating agent labels (above the head)
  verbLabels: Record<
    | 'entering'
    | 'reading'
    | 'searching'
    | 'fetching'
    | 'editing'
    | 'writing'
    | 'running'
    | 'delegating'
    | 'working'
    | 'asking'
    | 'waiting'
    | 'idle',
    string
  >;
}

const zh: Strings = {
  panelTitle: '行为模拟',
  panelAdd: '+ 生成',
  panelEmpty: '点 "+ 生成" 造一个 agent',
  panelAgents: (n: number) => `${n} 个 agent`,
  panelTools: '工具',
  panelActions: '动作',
  panelNotify: '! 举手',
  panelWaiting: '等待',
  panelIdle: '离座',
  panelWalkPrefix: '→ ',
  panelLog: '日志',
  logPanelTitle: '事件日志',
  logPanelEmpty: '暂无事件',
  stateIdle: '离座中',
  stateActive: '工作中',
  bubblePermission: '举手',
  bubbleWaiting: '等待',

  targetDoor: '门口',
  targetWhiteboard: '白板',
  targetBookshelfL: '书架·左',
  targetBookshelfR: '书架·右',
  targetWaterCooler: '饮水机',
  targetPantryCoffee: '工位咖啡',
  targetSofaCoffee: '休息区',
  targetMeeting: '会议桌',
  targetBin: '垃圾桶',

  legendTitle: '行为图例',
  legendClose: '收起',
  legendOpen: '图例',
  legendHookCol: '触发条件',
  legendActionCol: '像素动作',
  legendFurnitureCol: '家具 / 位置',
  legendRows: [
    { hook: '进入会话', action: '从门口走入 → 走到工位', furniture: '门 → 工位' },
    { hook: '进入后 5 秒无工具调用', action: '走到白板思考', furniture: '白板' },
    { hook: '编辑 / 写文件 / 派发子任务', action: '坐下 + 打字抖动', furniture: '工位椅子 + PC' },
    { hook: '执行 shell 命令', action: '坐下执行命令', furniture: '工位 PC' },
    { hook: '执行 rm / 删除命令', action: '走到垃圾桶扔东西 → 回座', furniture: '垃圾桶' },
    { hook: '读取 / 搜索代码', action: '走到书架 → 翻书动画', furniture: '书架' },
    { hook: '联网抓取 / 搜索', action: '翻书动画（同上）', furniture: '书架' },
    { hook: '等待权限确认', action: '原地举手 + ! 气泡', furniture: '—' },
    { hook: '等待用户输入', action: '原地 … 气泡', furniture: '—' },
    { hook: '本轮结束（暂停）', action: '坐姿呼吸 / 静止 + 等待气泡', furniture: '原工位' },
    { hook: '暂停后空闲 > 60s', action: '走到休息区沙发', furniture: '沙发' },
    { hook: '长时会话首次空闲', action: '先去饮水机喝水 → 回座', furniture: '饮水机' },
    { hook: '久坐空闲（环境行为）', action: '偶尔抬头看挂钟', furniture: '挂钟' },
    { hook: '会话结束', action: '矩阵雨淡出 → 移除', furniture: '—' },
  ],
  verbLabels: {
    entering: '进入',
    reading: '阅读',
    searching: '搜索',
    fetching: '抓取',
    editing: '编辑',
    writing: '书写',
    running: '执行',
    delegating: '委派',
    working: '工作',
    asking: '求助',
    waiting: '等待',
    idle: '空闲',
  },
};

const en: Strings = {
  panelTitle: 'Mock Events',
  panelAdd: '+ Add',
  panelEmpty: 'Click "+ Add" to spawn an agent',
  panelAgents: (n: number) => `${n} agent${n === 1 ? '' : 's'}`,
  panelTools: 'Tools',
  panelActions: 'Actions',
  panelNotify: '! Notify',
  panelWaiting: 'Waiting',
  panelIdle: 'Leave seat',
  panelWalkPrefix: '→ ',
  panelLog: 'Log',
  logPanelTitle: 'Event Log',
  logPanelEmpty: 'No events yet',
  stateIdle: 'idle',
  stateActive: 'active',
  bubblePermission: 'perm',
  bubbleWaiting: 'wait',

  targetDoor: 'door',
  targetWhiteboard: 'whiteboard',
  targetBookshelfL: 'bookshelf·L',
  targetBookshelfR: 'bookshelf·R',
  targetWaterCooler: 'water',
  targetPantryCoffee: 'pantry·☕',
  targetSofaCoffee: 'lounge',
  targetMeeting: 'meeting',
  targetBin: 'bin',

  legendTitle: 'Behavior Legend',
  legendClose: 'close',
  legendOpen: 'legend',
  legendHookCol: 'Trigger',
  legendActionCol: 'Pixel action',
  legendFurnitureCol: 'Furniture / spot',
  legendRows: [
    { hook: 'Session starts', action: 'walk in from door → to desk', furniture: 'door → desk' },
    { hook: 'No tool call in first 5s', action: 'stand at whiteboard (planning)', furniture: 'whiteboard' },
    { hook: 'Edit / write / delegate task', action: 'sit + typing shudder', furniture: 'pair-desk + PC' },
    { hook: 'Run shell command', action: 'sit and run command', furniture: 'desk PC' },
    { hook: 'Run rm / delete command', action: 'detour to bin → back to seat', furniture: 'bin' },
    { hook: 'Read / search code', action: 'walk to bookshelf → page flip', furniture: 'bookshelf' },
    { hook: 'Web fetch / search', action: 'page flip (same as read)', furniture: 'bookshelf' },
    { hook: 'Waiting for permission', action: 'raise hand + ! bubble', furniture: '—' },
    { hook: 'Waiting for user input', action: '… bubble in place', furniture: '—' },
    { hook: 'Turn stopped (paused)', action: 'seated breathing + waiting bubble', furniture: 'own desk' },
    { hook: 'Idle > 60s after stop', action: 'walk to lounge sofa', furniture: 'sofa' },
    { hook: 'Long session, first idle', action: 'detour to water cooler → back', furniture: 'cooler' },
    { hook: 'Long idle (ambient)', action: 'occasional glance at clock', furniture: 'clock' },
    { hook: 'Session ends', action: 'matrix fade out → removed', furniture: '—' },
  ],
  verbLabels: {
    entering: 'Entering',
    reading: 'Reading',
    searching: 'Searching',
    fetching: 'Fetching',
    editing: 'Editing',
    writing: 'Writing',
    running: 'Running',
    delegating: 'Delegating',
    working: 'Working',
    asking: 'Asking',
    waiting: 'Waiting',
    idle: 'Idle',
  },
};

export const STRINGS: Record<Lang, Strings> = { zh, en };
