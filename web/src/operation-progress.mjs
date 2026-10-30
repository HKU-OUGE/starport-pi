const stages = {
  updating_worker: "更新执行器接口",
  downloading_rootfs: "下载系统镜像",
  downloading_runtime: "下载隔离运行时",
};
const phases = {
  cached: "使用已校验缓存",
  resuming: "正在接续缓存",
  connecting: "正在连接",
  restarting: "下载源不支持续传，重新下载",
  downloading: "下载中",
  verifying: "校验中",
  verified: "校验通过",
};
const errors = {
  download_idle_timeout: "下载停滞，缓存已保留",
  download_attempt_timeout: "本次连接超时，缓存已保留",
  download_connection_timeout: "连接超时，缓存已保留",
  download_connection_interrupted: "连接中断，缓存已保留",
  download_incomplete: "文件未收全，缓存已保留",
  download_proxy_unavailable: "所选代理不可用",
  download_connection_refused: "下载连接被拒绝",
  download_dns_failed: "无法解析下载地址",
  download_tls_verification_failed: "下载站证书校验失败",
  download_disk_full: "缓存磁盘空间不足",
  download_cache_permission_denied: "无法写入下载缓存",
  download_cache_io_failed: "下载缓存读写失败",
  download_cache_busy: "另一下载正在使用此缓存",
  download_checksum_failed: "文件校验失败，未用于安装",
  download_cache_checksum_failed: "完整缓存校验失败，未用于安装",
  download_range_mismatch: "下载源返回的续传位置不一致",
  download_partial_restarting: "原缓存无法接续，重新下载",
};
export function downloadErrorLabel(code) {
  return (
    errors[code] ||
    (/^download_http_\d{3}$/.test(code || "")
      ? `下载站返回 HTTP ${code.slice(-3)}`
      : code)
  );
}
export function operationProgress(op) {
  const d = op.detail || {},
    pieces = [stages[op.stage] || op.stage];
  if (d.phase === "retrying")
    pieces.push(
      `等待重试 ${d.attempt + 1}/${d.maxAttempts}（${Math.ceil(d.retryInMs / 1000)} 秒）`,
    );
  else if (phases[d.phase]) pieces.push(phases[d.phase]);
  if (d.phase === "downloading" && d.resumed) pieces.push("断点续传");
  if (d.phase !== "retrying" && d.attempt > 1)
    pieces.push(`第 ${d.attempt}/${d.maxAttempts} 次连接`);
  if (Number.isFinite(d.bytes))
    pieces.push(
      `${(d.bytes / 1048576).toFixed(1)} MiB${d.total ? " / " + (d.total / 1048576).toFixed(1) + " MiB" : ""}`,
    );
  const error = op.error || (d.phase === "retrying" ? d.error : null);
  if (error) pieces.push(downloadErrorLabel(error));
  if (op.result?.updated?.length)
    pieces.push("已更新：" + op.result.updated.join("、"));
  return pieces.filter(Boolean).join(" · ");
}
