import Link from "next/link";
import { CreateCaseDialog } from "@/components/CreateCaseDialog";
import { Icon, type IconName } from "@/components/Icon";
import { REGISTRATION_CATEGORIES } from "@/lib/categories";
import type { CSSVarStyle } from "@/lib/css-vars";

const STATS: Array<{ label: string; icon: IconName; color?: string; bg?: string; foot: string }> = [
  { label: "งานทั้งหมด", icon: "stack", foot: "รวมทุกประเภทงาน" },
  { label: "รอดำเนินการ", icon: "clock", color: "#bd8a2c", bg: "#fff6e5", foot: "รอรับเรื่องและตรวจเอกสาร" },
  { label: "กำลังดำเนินการ", icon: "sync", color: "#5966d3", bg: "#f0efff", foot: "อยู่ระหว่างดำเนินงาน" },
  { label: "เสร็จสิ้น", icon: "check", color: "#248c6a", bg: "#eaf7f2", foot: "ดำเนินงานเรียบร้อยแล้ว" },
];

const STATUS_BREAKDOWN = [
  { label: "รอดำเนินการ", color: "#e6b35c" },
  { label: "กำลังดำเนินการ", color: "#7180e6" },
  { label: "เสร็จสิ้น", color: "#50ad8d" },
];

// หน้าภาพรวมเดิม (ต้นแบบ) - ยังใช้กับ ACCOUNTANT จนกว่าผู้ใช้จะกำหนดภาพรวมของบทบาทนั้น (ADMIN ใช้ ExecutiveOverview)
export function RegistrationOverview() {
  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>ภาพรวมงานทะเบียน</h1>
          <p>ติดตามงานทั้งหมด และเริ่มงานทะเบียนในที่เดียว</p>
        </div>
        <CreateCaseDialog />
      </div>

      <section className="stats" aria-label="สรุปสถานะงาน">
        {STATS.map((stat) => (
          <div className="stat" key={stat.label}>
            <div className="stat-top">
              {stat.label}
              <span className="icon" style={{ "--c": stat.color, "--bg": stat.bg } as CSSVarStyle}>
                <Icon name={stat.icon} />
              </span>
            </div>
            <div className="num">
              0<small>รายการ</small>
            </div>
            <div className="foot">{stat.foot}</div>
          </div>
        ))}
      </section>

      <div className="section-head">
        <h2>เริ่มต้นงานทะเบียน</h2>
        <span>เลือกประเภทงานที่ต้องการดำเนินการ</span>
      </div>
      <section className="types">
        {REGISTRATION_CATEGORIES.map((category) => (
          <Link href={category.href} className="type" key={category.href}>
            <span className="icon" style={{ "--c": category.color, "--bg": category.bg } as CSSVarStyle}>
              <Icon name={category.icon} />
            </span>
            <strong>{category.title}</strong>
            <span className="type-bottom">
              <span />
              <span aria-hidden="true">↗</span>
            </span>
          </Link>
        ))}
      </section>

      <div className="lower">
        <section className="panel">
          <div className="panel-head">
            <h2>รายการล่าสุด</h2>
            <span className="muted">0 รายการ</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>เลขที่งาน / วันที่</th>
                  <th>ประเภทงาน</th>
                  <th>ผู้รับผิดชอบ</th>
                  <th>สถานะ</th>
                </tr>
              </thead>
              <tbody />
            </table>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>สัดส่วนสถานะงาน</h2>
          </div>
          <div className="overview">
            {STATUS_BREAKDOWN.map((item) => (
              <div className="progress-item" key={item.label}>
                <div className="progress-label">
                  <span>{item.label}</span>
                  <b>0</b>
                </div>
                <div className="track">
                  <div className="fill" style={{ width: "0%", "--c": item.color } as CSSVarStyle} />
                </div>
              </div>
            ))}
            <div className="summary">
              <span className="icon" style={{ "--c": "#248c6a", "--bg": "#eaf7f2" } as CSSVarStyle}>
                <Icon name="check" />
              </span>
              <div>
                <b>—</b>
                <br />
                ของงานทั้งหมดเสร็จสิ้นแล้ว
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="bottom-note">
        <span>ต้นแบบหน้าจอ</span>
        <span>TRANSPORT WORKSPACE / 01</span>
      </div>
    </div>
  );
}
