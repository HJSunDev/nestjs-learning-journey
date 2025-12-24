# 007. IoC (控制反转) 与 DI (依赖注入) 核心原理

## 1. 核心问题与概念 (The "Why")

- **解决什么问题**:

  - **紧耦合 (Tight Coupling)**: 在传统代码中，如果类 A 直接创建类 B 的实例 (`new B()`)，那么 A 就强依赖于 B 的具体实现。一旦 B 需要替换（比如从“支付宝支付”换成“微信支付”，或者在测试时换成“模拟支付”），必须修改 A 的代码。
  - **可维护性与测试难题**: 难以单独测试 A，因为必须连带着 B 一起运行。
- **核心概念**:

  - **IoC (Inversion of Control - 控制反转)**: 这是一种**设计思想**。将“对象的创建”和“依赖关系的维护”这两个权力，从业务代码手里收回，交给一个独立的“外部容器”来管理。
  - **DI (Dependency Injection - 依赖注入)**: 这是 IoC 的一种**具体实现手段**。指对象不需要自己查找或创建依赖，而是由容器在运行时，将其依赖的对象通过构造函数等方式“注入”进来。

---

## 2. 核心用法 / 方案设计 (Usage / Design)

### 2.1 脱离框架看原理 (Raw TypeScript Implementation)

为了理解 NestJS 在幕后做了什么，我们先用原生 TypeScript 模拟一个场景：**订单服务 (OrderService) 依赖 支付服务 (PaymentService)**。

#### ❌ 阶段一：紧耦合 (硬编码依赖)

```typescript
// 具体的支付实现
class AliPayService {
  pay(amount: number) { console.log(`AliPay: ${amount}`); }
}

class OrderService {
  private paymentService: AliPayService;

  constructor() {
    // 💀 致命问题：OrderService 亲自创建了依赖。
    // 如果要换成 WechatPay，必须修改 OrderService 的代码。
    // 如果要做单元测试，很难把真实的 AliPay 替换成 Mock 对象。
    this.paymentService = new AliPayService();
  }

  checkout(amount: number) {
    this.paymentService.pay(amount);
  }
}
```

#### ✅ 阶段二：DI 模式 (依赖注入)

我们引入**接口**，并将依赖对象的创建移到外部。

```typescript
// 1. 定义接口（契约）
interface IPaymentService {
  pay(amount: number): void;
}

// 2. 具体实现
class AliPayService implements IPaymentService {
  pay(amount: number) { console.log('AliPay paying...'); }
}

class WechatPayService implements IPaymentService {
  pay(amount: number) { console.log('WechatPay paying...'); }
}

// 3. 消费者 (OrderService)
class OrderService {
  // 核心变化：只依赖接口，且通过构造函数接收实例
  constructor(private paymentService: IPaymentService) {}

  checkout(amount: number) {
    this.paymentService.pay(amount);
  }
}

// --- 手动模拟 IoC 容器的行为 (Main.ts) ---

// 此时，控制权在 Main 函数（组装者），而不是 OrderService
const useWechat = true;
const paymentImpl = useWechat ? new WechatPayService() : new AliPayService();

// 注入依赖
const order = new OrderService(paymentImpl); 
order.checkout(100);
```

#### 🚀 阶段三：IoC 容器 (自动化管理)

如果系统有几百个类，手动组装 (`new A(new B(new C()))`) 会非常痛苦。我们需要一个**容器**来自动完成这个过程。

```typescript
// 简易容器模拟
class Container {
  private services = new Map();

  // 注册服务
  register(name: string, implementation: any) {
    this.services.set(name, implementation);
  }

  // 获取服务（自动注入依赖）
  resolve(name: string) {
    const ServiceClass = this.services.get(name);
    // 假设我们知道 OrderService 依赖 'payment'
    // 在真实框架中，这一步通过反射（Reflection）自动分析元数据完成
    if (name === 'order') {
      const payment = this.resolve('payment');
      return new ServiceClass(payment);
    }
    return new ServiceClass();
  }
}

// 使用容器
const container = new Container();
container.register('payment', AliPayService);
container.register('order', OrderService);

const myOrderService = container.resolve('order'); // 自动组装完成！
```

---

### 2.2 NestJS 中的 IoC 实现机制

NestJS 的核心就是一个强大的 IoC 容器。它利用 TypeScript 的 **装饰器 (Decorators)** 和 **反射 (Reflect Metadata)** 实现了全自动的依赖注入。

1. **`@Injectable()`**: 标记一个类可以由 Nest IoC 容器管理。
2. **`@Module()`**: 告诉容器，这一组类（Controllers, Providers）属于同一个上下文，并定义它们如何被创建。
3. **构造函数注入**: 只要在 constructor 中写了类型，Nest 就会自动查找并注入。

#### 核心逻辑流

1. **应用启动**: Nest 扫描主模块 (`AppModule`) 及其导入的所有子模块。
2. **依赖解析**:
   - 遇到 `UserService`，发现它依赖 `UserRepository`。
   - 容器查找 `UserRepository` 的 Provider。
   - 如果 `UserRepository` 还没实例化，先实例化它（Singleton 默认）。
3. **实例创建**: 拿着实例化好的 `UserRepository`，去创建 `UserService`。
4. **结果**: 整个依赖树构建完成，应用准备就绪。

---

## 3. 实战代码演示 (Code in Action)

**场景**: 用户的密码需要加密存储。`UserService` 依赖一个 `CipherService` 来处理加密逻辑。

### 步骤 1: 定义 Provider (CipherService)

```typescript
// src/common/cipher.service.ts
import { Injectable } from '@nestjs/common';

// 1. 标记为可注入
@Injectable()
export class CipherService {
  hash(content: string): string {
    return `encrypted_${content}`; // 模拟加密
  }
}
```

### 步骤 2: 定义消费者 (UserService)

```typescript
// src/user/user.service.ts
import { Injectable } from '@nestjs/common';
import { CipherService } from '../common/cipher.service';

@Injectable()
export class UserService {
  // 2. 通过构造函数声明依赖
  // NestJS 通过 TypeScript 的类型元数据（Reflect Metadata）
  // 自动识别到这里需要注入一个 CipherService 的实例
  constructor(private readonly cipherService: CipherService) {}

  register(username: string, pass: string) {
    const hashedPassword = this.cipherService.hash(pass);
    console.log(`User ${username} registered with password: ${hashedPassword}`);
    // ... 保存逻辑
  }
}
```

### 步骤 3: 模块注册 (UserModule)

**这一步至关重要**。如果不注册，NestJS 不知道 `CipherService` 属于谁，会报错。

```typescript
// src/user/user.module.ts
import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { CipherService } from '../common/cipher.service';

@Module({
  // 3. 在 providers 数组中注册所有涉及的服务
  // 简写模式: CipherService 等同于 { provide: CipherService, useClass: CipherService }
  providers: [UserService, CipherService], 
  exports: [UserService], // 如果其他模块要用 UserService，这里要导出
})
export class UserModule {}
```

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

- ✅ **面向接口编程**: 尽量基于 Interface 或 Abstract Class 注入，而不是具体类（虽然 NestJS 中直接用类也很常见）。这让 Mock 测试更容易。
- ✅ **显式注入 (Token)**: 如果不能直接用类名（比如注入一个常量字符串配置），可以使用 `@Inject('CONFIG_TOKEN')` 装饰器。
- ❌ **循环依赖 (Circular Dependency)**: A 依赖 B，B 又依赖 A。NestJS 会报错。
  - *解决*: 使用 `forwardRef(() => ModuleB)` 或重构代码逻辑，抽取公共依赖 C。
- ❌ **忘记注册 Provider**: 常见报错 `Nest can't resolve dependencies of the UserService (?)`。通常是因为 `CipherService` 没在当前 Module 的 `providers` 里，也没从其他 Module `imports` 进来。

---

## 5. 行动导向 (Action Guide)

**(类型 C: 方案实现) -> 如何为一个新功能添加服务依赖**

- [Step 1] **创建服务类**: 创建 `xxx.service.ts`，添加 `@Injectable()` 装饰器，编写业务逻辑。
- [Step 2] **注册服务**: 打开该功能所属的 `xxx.module.ts`，将服务类放入 `providers` 数组。
- [Step 3] **注入使用**: 在需要使用该服务的 Controller 或其他 Service 中，通过 `constructor(private readonly xxxService: XxxService) {}` 进行注入。
