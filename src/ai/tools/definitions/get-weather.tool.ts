import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * 天气数据获取函数的类型签名
 *
 * 通过将数据获取逻辑抽象为可替换的函数，工具定义与数据来源解耦：
 * - 开发/测试环境：注入 mock 函数
 * - 生产环境：注入调用真实天气 API 的函数
 */
export type WeatherFetcher = (city: string) => Promise<string>;

/**
 * 默认的模拟天气数据获取函数
 *
 * 基于城市名哈希生成确定性模拟数据，
 * 确保同一城市每次返回相同结果，便于调试和测试。
 */
const defaultWeatherFetcher: WeatherFetcher = (city: string) => {
  // 基于城市名生成确定性伪随机值
  let hash = 0;
  for (const char of city) {
    hash = (hash << 5) - hash + char.charCodeAt(0);
    hash |= 0;
  }

  const conditions = ['晴', '多云', '阴', '小雨', '大雨', '雷阵雨', '雪', '雾'];
  const winds = [
    '东风 2级',
    '南风 3级',
    '西风 1级',
    '北风 4级',
    '东南风 2级',
    '西北风 3级',
  ];

  const absHash = Math.abs(hash);
  const temperature = (absHash % 40) - 5;
  const humidity = (absHash % 60) + 30;
  const condition = conditions[absHash % conditions.length];
  const wind = winds[absHash % winds.length];

  return Promise.resolve(
    `${city}当前天气：` +
      `温度 ${temperature}°C，` +
      `湿度 ${humidity}%，` +
      `${condition}，` +
      `${wind}。`,
  );
};

/**
 * 天气查询工具
 *
 * 演示需要外部数据源的 Tool Calling 场景。
 * 当用户询问某个城市的天气时，模型会调用此工具获取信息，
 * 再基于工具返回的数据组织自然语言回复。
 *
 * 接受可选的 fetcher 参数，实现数据获取逻辑的可替换：
 * - 默认使用 mock 数据（开发/测试）
 * - 生产环境可注入真实实现，例如：
 *
 *   ```ts
 *   // 在 ToolRegistry 中，通过 NestJS DI 获取 HttpService 后注入
 *   const realFetcher: WeatherFetcher = async (city) => {
 *     const res = await httpService.axiosRef.get(
 *       `https://api.weather.com/v1/current?city=${city}&key=${apiKey}`,
 *     );
 *     return `${city}当前天气：温度 ${res.data.temp}°C，${res.data.text}。`;
 *   };
 *   this.register(createGetWeatherTool(realFetcher));
 *   ```
 *
 * @param fetcher 可选的天气数据获取函数，默认使用 mock 实现
 */
export function createGetWeatherTool(
  fetcher: WeatherFetcher = defaultWeatherFetcher,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'get_weather',
    description:
      '查询指定城市的当前天气信息，包括温度、湿度、天气状况和风力。' +
      '当用户询问天气相关问题时使用此工具。',
    schema: z.object({
      city: z
        .string()
        .describe('要查询天气的城市名称，如 "北京"、"上海"、"New York"'),
    }),
    func: async ({ city }: { city: string }) => {
      return await fetcher(city);
    },
  });
}
