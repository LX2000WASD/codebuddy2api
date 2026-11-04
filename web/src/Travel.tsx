import { DataValue } from "./values";
import s from "./Travel.module.scss";

/**
 * The travel facts a credential card, a drawer or a maintenance toast can state.
 *
 * Every line is conditional: a missing field is never rendered as "unknown", because the
 * backend uses absence to mean "this account never reported it". The wrapper is a column
 * so the lines read as a list instead of running together on one line.
 */
export function TravelSummary({ trip }: { trip: Record<string, unknown> | null }) {
  if (!trip) return null;
  const remaining = trip.remaining_seconds;
  const minutes =
    trip.state === "traveling" &&
    trip.stale !== true &&
    typeof remaining === "number" &&
    Number.isFinite(remaining) &&
    remaining >= 0
      ? Math.ceil(remaining / 60)
      : null;
  const knownInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value);
  return (
    <div className={s.travel}>
      {typeof trip.location_name === "string" && trip.location_name && (
        <small>旅行地点：{trip.location_name}</small>
      )}
      {minutes !== null && (
        <small>
          查询时剩余：
          {minutes === 0
            ? "预计已到达，请查询核验"
            : minutes >= 60
              ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
              : `${minutes} 分钟`}
        </small>
      )}
      {trip.claimed === true && trip.claimed_credit == null && (
        <small>领取已确认，积分数额未返回</small>
      )}
      {trip.departure_pending === true && <small>派遣记录待核验，不重复派出</small>}
      {trip.claim_pending === true && <small>奖励领取待核验，不重复领取</small>}
      {trip.buddy_consent_accepted === true && <small>首领同意已保存，无需重复确认</small>}
      {trip.buddy_task_chat_sent === true && <small>新手对话已尝试，不自动重复发送</small>}
      {trip.buddy_task_completed === true && <small>官方新手任务已确认完成</small>}
      {trip.buddy_claimed === true && <small>猫猫已领取</small>}
      {trip.agreement_accepted === true && <small>官方协议已确认</small>}
      {trip.auto_accept_buddy === true && <small>首次领猫预授权：已开启</small>}
      {typeof trip.retry_at === "number" && Number.isFinite(trip.retry_at) && (
        <small>
          首领退避至：
          <DataValue name="retry_at" value={trip.retry_at} />
        </small>
      )}
      {typeof trip.phase === "string" && (
        <small>
          阶段：
          <DataValue name="phase" value={trip.phase} />
          {typeof trip.error_kind === "string" && (
            <>
              {" · "}
              <DataValue name="error_kind" value={trip.error_kind} />
            </>
          )}
          {knownInteger(trip.http_status) && ` · HTTP ${trip.http_status}`}
          {knownInteger(trip.code) && ` · 业务码 ${trip.code}`}
        </small>
      )}
    </div>
  );
}
