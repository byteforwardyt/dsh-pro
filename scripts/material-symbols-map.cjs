'use strict'
// UI meaning -> Google Material Symbols Rounded, unfilled / 400 / 24px.
// Brands, document thumbnails, live progress rings and the app mark are not UI icons.
module.exports = {
  revision: '737e3324305806514d7909874fa1818ae1808232',
  native: {
    NewChat: 'edit_square', Search: 'search', Globe: 'language', Settings: 'settings',
    PanelLeft: 'left_panel_close', Ellipsis: 'more_horiz', Plus: 'add', Check: 'check', Branch: 'fork_right',
    ChevronDown: 'expand_more', ChevronLeft: 'chevron_left', ChevronRight: 'chevron_right', ChevronUp: 'expand_less',
    TriangleRight: 'arrow_right', Close: 'close', CloseCircle: 'cancel', Copy: 'content_copy', Refresh: 'refresh',
    Like: 'thumb_up', Dislike: 'thumb_down', Share: 'ios_share', DeliverDoc: 'file_export', Edit: 'edit',
    Think: 'psychology', AgentPreset: 'tune', Browse: 'travel_explore', ContextInjection: 'library_add',
    Link: 'link', RightUp: 'open_in_new', Enhance: 'auto_fix_high', Trash: 'delete', Warning: 'error',
    CheckCircle: 'check_circle', WarningTriangle: 'warning', User: 'person', Users: 'groups',
    PaperPlane: 'send', Stop: 'stop', Paperclip: 'attach_file', Download: 'download', Play: 'play_arrow', Pause: 'pause',
    Fullscreen: 'fullscreen', Code: 'code', CordisPlugin: 'extension', Api: 'api', Personalization: 'palette',
    ProjectAdd: 'create_new_folder', FolderOpen: 'folder_open', FolderClose: 'folder', TreeCorner: 'subdirectory_arrow_right',
    Light: 'light_mode', Dark: 'dark_mode', Followsystem: 'contrast', Data: 'bar_chart', Database: 'database',
    Clock: 'schedule', Gauge: 'speed', Send: 'arrow_upward', Queue: 'forum', Checklist: 'checklist', ListPen: 'edit_note',
    Goal: 'flag', Sparkle: 'auto_awesome', Inspect: 'ads_click', Skill: 'menu_book', Question: 'help', Info: 'info',
    PluginPinwheel: 'extension', AlarmClock: 'alarm', Archive: 'archive', WrapLines: 'wrap_text', Nowrap: 'text_format',
    Wrap: 'wrap_text', CompareSplit: 'compare', Plan: 'edit_note', Compact: 'compress', Shield: 'shield',
    Unarchive: 'unarchive', Pin: 'push_pin', FlatList: 'format_list_bulleted', WorkspaceTree: 'account_tree',
    ChevronsUpDown: 'unfold_more', ArchiveOff: 'unarchive', ArchiveCheck: 'inventory_2', SlidersTwo: 'tune', Microphone: 'mic',
  },
  views: { chat: 'code', trajectory: 'route', preview: 'web', files: 'folder_open', terminal: 'terminal' },
  settings: { general: 'settings', accounts: 'manage_accounts', account: 'person', workspaces: 'folder_open', about: 'info', usage: 'bar_chart', computer: 'desktop_windows', development: 'terminal', phone: 'smartphone', models: 'smart_toy', 'model-connections': 'hub', plugins: 'extension', 'agent-presets': 'tune' },
  dictionaries: [
    ['client-ui-workspace-tools', 'ICONS', { plugins: 'extension', scheduled: 'event_repeat', prs: 'merge', back: 'arrow_back', refresh: 'refresh', plus: 'add', close: 'close', computer: 'desktop_windows', terminal: 'terminal', files: 'folder_open', preview: 'web', media: 'perm_media', phone: 'smartphone', notify: 'notifications', trash: 'delete' }],
    ['client-ui-inspector', 'paths', { panel: 'right_panel_open', close: 'close', git: 'fork_right', changes: 'difference', local: 'computer', agent: 'smart_toy', terminal: 'terminal', file: 'draft', folder: 'folder', chevron: 'chevron_right', refresh: 'refresh' }],
    ['client-ui-files', 'TOOLS', { sidebar: 'left_panel_close', search: 'search', findText: 'manage_search', history: 'history', copy: 'content_copy', reload: 'refresh' }],
  ],
  // Stable owned control selectors; never translated text or arbitrary SVG replacement.
  controls: {
    '.dshd-tm-toggle>svg': 'terminal', '.dshd-attach-button>svg': 'attach_file', '.dshd-computer .hero>svg': 'desktop_windows',
    '.dshd-fl-caret': 'chevron_right', '.sc-mode-icon': 'groups', '.dshd-material-back': 'arrow_back',
    '.sc-send>span': 'arrow_upward', '.sc-send[aria-label="Cancel response"]>span': 'stop',
    '.dshd-tools-trigger[aria-label="Open files"]>svg': 'folder_open',
    '.dshd-tools-trigger[aria-label="Open preview"]>svg': 'web',
    '.dshd-tools-trigger[aria-label="Open workspace tools"]>svg': 'folder_open',
    '.dshd-tools-close>svg': 'arrow_back', '.dshd-ws-mark>svg': 'folder_open', '.dshd-ws-pin>svg': 'push_pin',
    '.dshd-ph-note>svg': 'shield', '.dshd-us-hero>svg': 'bar_chart',
  },
  preview: ['chevron_left', 'chevron_right', 'refresh', 'ads_click', 'open_in_new', 'draft'],
}
