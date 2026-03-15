#!/usr/bin/env python3
"""
清理纸面交易历史数据
保留配置，重置交易数据
"""

import sqlite3
import shutil
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "paper_trading.db"
BACKUP_DIR = Path(__file__).parent / "backups"

def backup_database():
    """备份数据库"""
    if not DB_PATH.exists():
        print(f"❌ 数据库文件不存在: {DB_PATH}")
        return None

    # 创建备份目录
    BACKUP_DIR.mkdir(exist_ok=True)

    # 生成备份文件名
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = BACKUP_DIR / f"paper_trading_backup_{timestamp}.db"

    # 复制数据库
    shutil.copy2(DB_PATH, backup_path)
    file_size = backup_path.stat().st_size / 1024 / 1024

    print(f"✅ 数据库已备份到: {backup_path}")
    print(f"   文件大小: {file_size:.2f} MB")

    return backup_path

def show_statistics(conn):
    """显示数据库统计"""
    cur = conn.cursor()

    # 获取统计信息
    cur.execute("SELECT COUNT(*) FROM paper_trades")
    total_trades = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM paper_trades WHERE exit_price IS NOT NULL")
    closed_trades = cur.fetchone()[0]

    cur.execute("SELECT ROUND(COALESCE(SUM(pnl), 0), 2) FROM paper_trades WHERE exit_price IS NOT NULL")
    total_pnl = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM paper_portfolio")
    open_positions = cur.fetchone()[0]

    return {
        "total_trades": total_trades,
        "closed_trades": closed_trades,
        "total_pnl": total_pnl,
        "open_positions": open_positions
    }

def clear_trading_data(conn):
    """清理交易数据"""
    cur = conn.cursor()

    print()
    print("🗑️  清理交易数据...")

    # 清理 paper_trades 表
    cur.execute("DELETE FROM paper_trades")
    trades_deleted = cur.rowcount
    print(f"   ✅ paper_trades: {trades_deleted:,} 条记录已删除")

    # 清理 paper_portfolio 表
    cur.execute("DELETE FROM paper_portfolio")
    portfolio_deleted = cur.rowcount
    print(f"   ✅ paper_portfolio: {portfolio_deleted} 条记录已删除")

    # 清理 strategy_trade_history 表（可选，保留策略学习数据）
    cur.execute("DELETE FROM strategy_trade_history")
    history_deleted = cur.rowcount
    print(f"   ✅ strategy_trade_history: {history_deleted:,} 条记录已删除")

    # 清理 strategy_performance 表（可选）
    cur.execute("DELETE FROM strategy_performance")
    perf_deleted = cur.rowcount
    print(f"   ✅ strategy_performance: {perf_deleted} 条记录已删除")

    # 重置计数器
    cur.execute("DELETE FROM sqlite_sequence WHERE name IN ('paper_trades', 'paper_portfolio')")
    print(f"   ✅ sqlite_sequence: 计数器已重置")

    conn.commit()

    return {
        "trades": trades_deleted,
        "portfolio": portfolio_deleted,
        "history": history_deleted,
        "performance": perf_deleted
    }

def main():
    print("=" * 70)
    print("🔄 纸面交易数据清理工具")
    print("=" * 70)
    print()

    # 步骤 1: 备份数据库
    print("步骤 1: 备份数据库")
    print("-" * 70)
    backup_path = backup_database()

    if not backup_path:
        print("❌ 备份失败，终止清理")
        return

    # 步骤 2: 显示清理前统计
    print()
    print("步骤 2: 清理前统计")
    print("-" * 70)

    conn = sqlite3.connect(DB_PATH)
    stats_before = show_statistics(conn)

    print(f"   总交易数: {stats_before['total_trades']:,}")
    print(f"   已平仓: {stats_before['closed_trades']:,}")
    print(f"   持仓中: {stats_before['open_positions']}")
    print(f"   总盈亏: ${stats_before['total_pnl']:,.2f}")

    # 确认清理
    print()
    print("⚠️  警告: 即将清理所有交易数据，不可恢复！")
    print()
    response = input("确认清理？(输入 YES 继续，其他取消): ")

    if response != "YES":
        print()
        print("❌ 用户取消清理")
        conn.close()
        return

    # 步骤 3: 清理数据
    print()
    print("步骤 3: 清理数据")
    print("-" * 70)
    deleted = clear_trading_data(conn)

    # 步骤 4: 显示清理后统计
    print()
    print("步骤 4: 清理后统计")
    print("-" * 70)
    stats_after = show_statistics(conn)

    print(f"   总交易数: {stats_after['total_trades']}")
    print(f"   已平仓: {stats_after['closed_trades']}")
    print(f"   持仓中: {stats_after['open_positions']}")
    print(f"   总盈亏: ${stats_after['total_pnl']}")

    conn.close()

    # 步骤 5: 总结
    print()
    print("=" * 70)
    print("✅ 清理完成")
    print("=" * 70)
    print()
    print("已删除数据:")
    print(f"  - paper_trades: {deleted['trades']:,} 笔交易")
    print(f"  - paper_portfolio: {deleted['portfolio']} 个持仓")
    print(f"  - strategy_trade_history: {deleted['history']:,} 行")
    print(f"  - strategy_performance: {deleted['performance']} 行")
    print()
    print("备份数据库:")
    print(f"  - 路径: {backup_path}")
    print()
    print("保留数据:")
    print("  - cycles: 策略周期配置")
    print("  - high_frequency_orders: 高频订单配置")
    print()
    print("🎯 现在可以从头开始纸面交易了！")
    print()

if __name__ == "__main__":
    main()