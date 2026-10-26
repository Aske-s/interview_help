/**
 * 语音活动判定的纯函数部分。
 *
 * 抽出来的原因：这段逻辑值得被直接单测。
 * 放在 orchestrator 里时，测试需要桩掉 asr/网关/settings，脚手架本身容易出错，
 * 反而掩盖真实行为（我在这上面浪费过一次时间）。
 */

/**
 * 更新噪声基底。
 *
 * 语义：**快速跟随更安静，极慢回升**。
 *
 * 曾经用第一帧的 RMS 初始化基底 —— 如果音频一开始就是人声，
 * 基底直接等于人声能量，`rms > floor * 2.2` 永远不成立，
 * 于是一路判不出「有语音」，只能靠硬上限把句子切碎。
 * 现在的初值取「当前值与一个很小的先验的较小者」，不会被人声带偏。
 *
 * @param prev 上一次的基底；0 表示尚未建立
 * @param rms  当前帧的归一化 RMS（0-1）
 */
export function nextNoiseFloor(prev: number, rms: number): number {
  if (!prev) return Math.min(rms, 0.02)
  if (rms < prev) return rms
  // 回升极慢（千分之一/帧）且封顶，避免把持续人声当成基底抬上去
  return Math.min(prev * 1.001, 0.05)
}

/**
 * 当前帧是否算「有语音」。
 *
 * 判据：显著高于噪声基底（2.2 倍），或绝对能量够大（安静环境下的下限保护）。
 * 绝对下限 0.0045 对应原版写死的 150/32768 ≈ 0.0046 —— 原版只用它更新计时器，
 * 这里作为基底判定之外的保护，避免极安静环境下基底过低造成误触发。
 */
export function isVoiceFrame(rms: number, noiseFloor: number): boolean {
  return rms > Math.max(noiseFloor * 2.2, 0.0045)
}
