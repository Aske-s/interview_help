import { registerChatIpc } from './chat'
import { registerCaptureIpc } from './capture'
import { registerDataIpc } from './data'
import { registerDiagnosticsIpc } from './diagnostics'
import { registerInterviewIpc } from './interview'
import { registerKnowledgeIpc } from './knowledge'
import { registerLiveIpc } from './live'
import { registerSystemIpc } from './system'
import { registerVoiceprintIpc } from './voiceprint'
import { registerGuardIpc } from './guard'
import { registerModesIpc } from './modes'
import { registerQuizbarIpc } from './quizbar'
import { registerClipboardIpc } from './clipboard'
import { registerSystemAudioIpc } from './system-audio'

/** 统一注册所有 IPC handler。新增模块时在这里挂载。 */
export function registerIpc(): void {
  registerSystemIpc()
  registerDiagnosticsIpc()
  registerVoiceprintIpc()
  registerGuardIpc()
  registerModesIpc()
  registerQuizbarIpc()
  registerClipboardIpc()
  registerSystemAudioIpc()
  registerChatIpc()
  registerDataIpc()
  registerKnowledgeIpc()
  registerLiveIpc()
  registerCaptureIpc()
  registerInterviewIpc()
}
