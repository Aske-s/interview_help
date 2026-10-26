import React from 'react'
import { Badge, Button, NavItem, Switch } from '@renderer/ui'
import type { SessionRecord, Settings } from '@shared/types'
import type { MainWindowApi } from '@shared/ipc'
import Home from './pages/Home'
import { Agents, Knowledge, Records, SettingsPage } from './pages/Sections'
import Diagnostics from './pages/Diagnostics'

/**
 * 主窗口外壳 —— 布局对齐「随思」原版：
 *   左侧固定侧边栏（头像 / 网关状态 / 主导航 / 底部安全模式）
 *   右侧内容区（由各 section 渲染）
 *
 * 原版的「账号用量 + 会员」区块在本地版替换为「模型网关状态」。
 */

const api = window.api as unknown as MainWindowApi

type SectionKey = 'home' | 'agents' | 'knowledge' | 'records' | 'diagnostics' | 'settings'

const NAV: Array<{ key: SectionKey; label: string }> = [
  { key: 'home', label: '面试/笔试' },
  { key: 'agents', label: 'AI 智能体' },
  { key: 'knowledge', label: '知识库' },
  { key: 'records', label: '最近记录' },
  { key: 'diagnostics', label: '设备与检查' },
  { key: 'settings', label: '高级设置' }
]

export default function App(): React.ReactElement {
  const [settings, setSettings] = React.useState<Settings | null>(null)
  const [section, setSection] = React.useState<SectionKey>('home')
  const [sessions, setSessions] = React.useState<SessionRecord[]>([])
  const [activeRecord, setActiveRecord] = React.useState<SessionRecord | null>(null)
  const [gatewayOk, setGatewayOk] = React.useState<boolean | null>(null)

  const reloadSessions = React.useCallback(() => {
    void api.sessions.list().then(setSessions)
  }, [])

  React.useEffect(() => {
    void api.settings.get().then(setSettings)
    reloadSessions()
    const off = api.settings.onChanged(setSettings)
    return off
  }, [reloadSessions])

  const provider = settings?.providers.find((p) => p.id === settings.activeProviderId) ?? settings?.providers[0]
  const configured = Boolean(provider?.baseUrl && provider?.model)

  /* 配置完成后做一次真实探针，把连通性显示在侧边栏 */
  React.useEffect(() => {
    if (!provider || !configured) {
      setGatewayOk(null)
      return
    }
    let cancelled = false
    void api.gateway.test(provider).then((result) => {
      if (!cancelled) setGatewayOk(result.ok)
    })
    return () => {
      cancelled = true
    }
  }, [provider?.id, provider?.baseUrl, provider?.model, provider?.apiKey, configured])

  const patch = React.useCallback(async (next: Parameters<MainWindowApi['settings']['patch']>[0]) => {
    setSettings(await api.settings.patch(next))
  }, [])

  const openRecord = (record: SessionRecord): void => {
    setActiveRecord(record)
    setSection('records')
  }

  if (!settings) {
    return (
      <div className="ss-app-shell flex h-full items-center justify-center text-[13px] text-[rgb(var(--ss-muted))]">
        加载中…
      </div>
    )
  }

  return (
    <div className="ss-app-shell flex h-full">
      {/* ---------------- 左侧边栏 ---------------- */}
      <aside className="flex w-[250px] shrink-0 flex-col border-r border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-shell))]">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[rgb(var(--ss-2))] text-[15px]">🐱</div>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">祝你成功🎉</div>
            <div className="ss-list-count truncate">自建 · 网关可配置</div>
          </div>
        </div>

        {/* 网关状态（替代原版的账号用量 / 会员区块） */}
        <div className="mx-3 mb-3 rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))] p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[12px] font-medium text-[rgb(var(--ss-muted))]">模型网关</span>
            {!configured ? (
              <Badge tone="warn">未配置</Badge>
            ) : gatewayOk === null ? (
              <Badge tone="muted">检测中</Badge>
            ) : gatewayOk ? (
              <Badge tone="ok">正常</Badge>
            ) : (
              <Badge tone="danger">不可用</Badge>
            )}
          </div>
          <div className="truncate text-[12px]" title={provider?.model}>
            {provider?.model || '—'}
          </div>
          <div className="ss-list-count mt-0.5 truncate" title={provider?.baseUrl}>
            {provider?.baseUrl || '未填写网关地址'}
          </div>
          {!configured && (
            <Button size="sm" variant="primary" className="mt-2 w-full" onClick={() => setSection('settings')}>
              去配置
            </Button>
          )}
        </div>

        <nav className="min-h-0 flex-1 space-y-0.5 overflow-auto px-2">
          {NAV.map((item) => (
            <NavItem
              key={item.key}
              active={section === item.key}
              onClick={() => {
                setSection(item.key)
                if (item.key !== 'records') setActiveRecord(null)
              }}
            >
              {item.label}
              {item.key === 'records' && sessions.length > 0 && (
                <span className="ss-list-count ml-auto">{sessions.length}</span>
              )}
            </NavItem>
          ))}
        </nav>

        <div className="border-t border-[rgb(var(--ss-border))] px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[12px] text-[rgb(var(--ss-muted))]">安全模式</span>
            <Switch checked={settings.stealth.safeMode} onChange={(v) => void patch({ stealth: { safeMode: v } })} />
            <button
              className="ml-1 flex h-6 w-6 items-center justify-center rounded-full border border-[rgb(var(--ss-border))] text-[11px] text-[rgb(var(--ss-muted))] ss-no-drag"
              title="检测到录屏/共享软件时会自动隐藏悬浮窗。检测基于进程名启发式判断，可能漏报。"
            >
              ?
            </button>
          </div>
        </div>
      </aside>

      {/* ---------------- 右侧内容区 ---------------- */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {section === 'home' && (
          <Home settings={settings} sessions={sessions} onReload={reloadSessions} onOpenRecord={openRecord} />
        )}
        {section === 'agents' && <Agents settings={settings} onPatch={patch} />}
        {section === 'knowledge' && <Knowledge />}
        {section === 'records' && (
          <Records sessions={sessions} active={activeRecord} onSelect={setActiveRecord} onReload={reloadSessions} />
        )}
        {section === 'diagnostics' && (
          <>
            <header className="shrink-0 px-6 pt-5">
              <h1 className="ss-page-title">设备与检查</h1>
              <p className="ss-list-count mt-1">
                开始会议或面试前确认麦克风、摄像头与权限；同时检测录屏与安全软件等环境风险。
              </p>
            </header>
            <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
                  <Diagnostics
                micDeviceId={settings.audio.micDeviceId}
                cameraDeviceId={settings.audio.cameraDeviceId}
                checkSystemAudio={settings.audio.systemAudioEnabled}
                preflightCheck={settings.preflightCheck}
                onPatch={patch}
              />
            </div>
          </>
        )}
        {section === 'settings' && <SettingsPage settings={settings} onPatch={patch} provider={provider} />}
      </main>
    </div>
  )
}
