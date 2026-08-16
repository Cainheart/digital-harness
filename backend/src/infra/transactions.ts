import BetterSqlite3 from "better-sqlite3";
import { Database } from "./database.js";

/** 提供 Task 2 仓储共享的原子同步事务边界。 */
export class UnitOfWork {
  connection!: BetterSqlite3.Database;
  private transaction:
    | ((connection: BetterSqlite3.Database) => unknown)
    | null = null;
  /** 绑定数据库并开始事务。 */
  constructor(private readonly database: Database) {}
  /** 开始事务并暴露连接。 */
  begin(): this {
    this.connection = this.database.connection;
    this.connection.exec("BEGIN");
    this.transaction = (connection) => connection;
    return this;
  }
  /** 提交事务。 */
  commit(): void {
    this.connection.exec("COMMIT");
    this.transaction = null;
  }
  /** 回滚事务。 */
  rollback(): void {
    if (this.transaction) {
      this.connection.exec("ROLLBACK");
      this.transaction = null;
    }
  }
  /** 在回调成功时提交，失败时回滚。 */
  run<T>(callback: (connection: BetterSqlite3.Database) => T): T {
    this.begin();
    try {
      const result = callback(this.connection);
      this.commit();
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }
}

/** 异步适配器保留与未来 Worker/HTTP 代码相同的事务调用形态。 */
export class AsyncUnitOfWork {
  constructor(private readonly database: Database) {}
  /** 在同步 SQLite 事务之上提供 Promise API。 */
  async run<T>(
    callback: (connection: BetterSqlite3.Database) => T | Promise<T>,
  ): Promise<T> {
    const tx = new UnitOfWork(this.database);
    tx.begin();
    try {
      const result = await callback(tx.connection);
      tx.commit();
      return result;
    } catch (error) {
      tx.rollback();
      throw error;
    }
  }
}
