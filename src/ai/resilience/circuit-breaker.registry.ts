import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  circuitBreaker,
  ConsecutiveBreaker,
  handleAll,
  type CircuitBreakerPolicy as CockatielCircuitBreaker,
  BrokenCircuitError,
} from 'cockatiel';
import type { CircuitBreakerPolicy } from './resilience.config';
import { DEFAULT_CIRCUIT_BREAKER_POLICY } from './resilience.config';

/**
 * 熔断器状态枚举
 *
 * 对齐 cockatiel 内部状态，用于 API 响应和监控日志。
 */
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

/**
 * 单个熔断器实例的运行时信息
 */
export interface CircuitBreakerInfo {
  /** 熔断器标识（通常是 provider 名称） */
  name: string;
  /** 当前状态 */
  state: CircuitState;
  /** 累计失败次数（自上次关闭以来） */
  failures: number;
  /** 累计成功执行次数 */
  successes: number;
  /** 上次状态变更的时间戳 */
  lastStateChangeAt?: number;
}

/**
 * Per-Provider 熔断器注册表
 *
 * 每个 AI 提供商拥有独立的熔断器实例，避免单个提供商故障
 * 导致所有提供商被熔断。底层使用 cockatiel 的 CircuitBreakerPolicy。
 *
 * 生命周期：
 * - 首次为某 provider 调用 execute() 时懒创建熔断器
 * - 熔断器实例在进程生命周期内持久存在（NestJS 单例）
 * - 状态变更事件自动写入日志（可对接告警系统）
 *
 * 与 ResilienceService 的协作：
 * ResilienceService.withCircuitBreaker() 调用本注册表的 execute()
 * 将 LLM 调用包裹在熔断器保护中。
 */
@Injectable()
export class CircuitBreakerRegistry {
  private readonly logger = new Logger(CircuitBreakerRegistry.name);

  /** provider → cockatiel 熔断器实例 */
  private readonly breakers = new Map<string, CockatielCircuitBreaker>();

  /** provider → 运行时统计（补充 cockatiel 不直接暴露的计数） */
  private readonly stats = new Map<
    string,
    { failures: number; successes: number; lastStateChangeAt: number }
  >();

  private readonly policy: CircuitBreakerPolicy;

  constructor(private readonly configService: ConfigService) {
    const threshold = this.configService.get<number>(
      'ai.circuitBreaker.consecutiveFailures',
    );
    const halfOpen = this.configService.get<number>(
      'ai.circuitBreaker.halfOpenAfterMs',
    );

    this.policy = {
      consecutiveFailures:
        threshold ?? DEFAULT_CIRCUIT_BREAKER_POLICY.consecutiveFailures,
      halfOpenAfterMs:
        halfOpen ?? DEFAULT_CIRCUIT_BREAKER_POLICY.halfOpenAfterMs,
    };

    this.logger.log(
      `熔断器策略: 连续 ${this.policy.consecutiveFailures} 次失败后熔断，` +
        `${this.policy.halfOpenAfterMs / 1000}s 后半开`,
    );
  }

  /**
   * 在熔断器保护下执行异步操作
   *
   * 如果指定 provider 的熔断器处于 OPEN 状态，
   * 直接抛出 BrokenCircuitError 而不执行实际操作。
   *
   * @param provider - AI 提供商标识（每个 provider 独立熔断）
   * @param fn - 要保护的异步操作（如 LLM API 调用）
   * @returns 操作执行结果
   * @throws {BrokenCircuitError} 当熔断器处于 OPEN 状态时
   */
  async execute<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const breaker = this.getOrCreate(provider);
    return breaker.execute(fn);
  }

  /**
   * 获取指定 provider 的熔断器状态信息
   *
   * @param provider - AI 提供商标识
   * @returns 熔断器信息，不存在则返回 undefined
   */
  getInfo(provider: string): CircuitBreakerInfo | undefined {
    const breaker = this.breakers.get(provider);
    if (!breaker) return undefined;

    const stat = this.stats.get(provider)!;
    return {
      name: provider,
      state: this.mapState(breaker.state),
      failures: stat.failures,
      successes: stat.successes,
      lastStateChangeAt: stat.lastStateChangeAt,
    };
  }

  /**
   * 获取所有熔断器状态信息
   *
   * @returns 所有已注册的熔断器信息列表
   */
  getAllInfo(): CircuitBreakerInfo[] {
    return Array.from(this.breakers.keys())
      .map((name) => this.getInfo(name))
      .filter((info): info is CircuitBreakerInfo => info !== undefined);
  }

  /**
   * 重置指定 provider 的熔断器为 CLOSED 状态
   *
   * @param provider - AI 提供商标识
   */
  reset(provider: string): void {
    const breaker = this.breakers.get(provider);
    if (breaker) {
      // cockatiel 没有直接 reset，删除并重新创建
      this.breakers.delete(provider);
      this.stats.delete(provider);
      this.logger.log(`熔断器已重置: ${provider}`);
    }
  }

  /**
   * 判断错误是否为熔断器拦截（快速失败）
   *
   * @param error - 捕获的错误
   */
  static isBrokenCircuitError(error: unknown): boolean {
    return error instanceof BrokenCircuitError;
  }

  /**
   * 懒创建 provider 级熔断器
   *
   * cockatiel 的 circuitBreaker(handleAll, options) 创建一个策略实例，
   * ConsecutiveBreaker(n) 表示连续 n 次失败后触发熔断。
   */
  private getOrCreate(provider: string): CockatielCircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (breaker) return breaker;

    breaker = circuitBreaker(handleAll, {
      halfOpenAfter: this.policy.halfOpenAfterMs,
      breaker: new ConsecutiveBreaker(this.policy.consecutiveFailures),
    });

    this.stats.set(provider, {
      failures: 0,
      successes: 0,
      lastStateChangeAt: Date.now(),
    });

    // 状态变更监听 — 写入日志，可对接告警
    breaker.onStateChange((state) => {
      const stat = this.stats.get(provider)!;
      stat.lastStateChangeAt = Date.now();

      const mapped = this.mapState(state);
      if (mapped === CircuitState.OPEN) {
        this.logger.error(
          `🔴 熔断器已开启: ${provider} — 连续 ${this.policy.consecutiveFailures} 次失败，` +
            `将在 ${this.policy.halfOpenAfterMs / 1000}s 后尝试恢复`,
        );
      } else if (mapped === CircuitState.HALF_OPEN) {
        this.logger.warn(`🟡 熔断器半开: ${provider} — 允许探测请求`);
      } else {
        this.logger.log(`🟢 熔断器已关闭: ${provider} — 服务已恢复`);
      }
    });

    breaker.onSuccess(() => {
      const stat = this.stats.get(provider);
      if (stat) stat.successes++;
    });

    breaker.onFailure(({ reason }) => {
      const stat = this.stats.get(provider);
      if (stat) stat.failures++;
      const message =
        reason instanceof Error ? reason.message : JSON.stringify(reason);
      this.logger.warn(`熔断器记录失败: ${provider} — ${message}`);
    });

    this.breakers.set(provider, breaker);
    this.logger.debug(`熔断器已创建: ${provider}`);

    return breaker;
  }

  /**
   * 将 cockatiel 内部状态映射为统一枚举
   */
  private mapState(state: unknown): CircuitState {
    const stateStr = String(state).toLowerCase();
    if (stateStr.includes('open') && !stateStr.includes('half')) {
      return CircuitState.OPEN;
    }
    if (stateStr.includes('half')) {
      return CircuitState.HALF_OPEN;
    }
    return CircuitState.CLOSED;
  }
}
