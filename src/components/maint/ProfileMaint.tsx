import { ProfileForm } from "../Profile";
import { PageHead } from "./Ui";

export default function ProfileMaint({ go }: { go: (view: string) => void }) {
  return (
    <>
      <PageHead
        title="积分档案"
        note={
          <>
            这份档案就是结算栏的唯一输入：就业、住所、教育、纳税、荣誉五项都从这里算。
            分段按起止年月折成月数，重叠的部分按先出现的段算；改动保存后立即重算，不缓存旧结果。
          </>
        }
      >
        <button className="m-btn m-btn-quiet" onClick={() => go("clauses")}>去条文与结算 →</button>
      </PageHead>

      <div className="px-8 md:px-16 pb-14">
        <div className="grid gap-x-14 gap-y-10 grid-cols-1 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
          <div>
            <ProfileForm onSaved={() => {}} />
          </div>

          <aside className="lg:pt-6">
            <div className="sans text-[10.5px] tracking-[.24em]" style={{ color: "var(--color-seal)" }}>
              记档口径
            </div>
            <div className="rule-red-thin mt-2 mb-4" />
            <ol className="text-[12.5px] leading-[2] list-none p-0 m-0" style={{ color: "var(--color-ink-2)" }}>
              <li className="flex gap-3">
                <span className="num shrink-0" style={{ color: "var(--color-mute)" }}>01</span>
                <span>只算到<b>申报当年</b>。申报年在前面的「条文与结算」里切，不在这页改。</span>
              </li>
              <li className="flex gap-3 mt-2">
                <span className="num shrink-0" style={{ color: "var(--color-mute)" }}>02</span>
                <span>住所可以分多段：租过、买过、换过区，都按段录，别合并成一段。</span>
              </li>
              <li className="flex gap-3 mt-2">
                <span className="num shrink-0" style={{ color: "var(--color-mute)" }}>03</span>
                <span>登记备案是计分前提。自有写「有产权证」，租赁写「已备案」，否则这一段按 0 分算。</span>
              </li>
              <li className="flex gap-3 mt-2">
                <span className="num shrink-0" style={{ color: "var(--color-mute)" }}>04</span>
                <span>在职就读要如实填学制，学制内会扣减同期的社保与住所分。</span>
              </li>
              <li className="flex gap-3 mt-2">
                <span className="num shrink-0" style={{ color: "var(--color-mute)" }}>05</span>
                <span>就业地与通勤线路在「公司地点线路维护」里单独管，它们不影响分数，只影响选房。</span>
              </li>
            </ol>

            <div
              className="mt-6 p-4 text-[12px] leading-[1.9]"
              style={{ background: "var(--color-paper-2)", borderLeft: "2px solid var(--color-rule-2)", color: "var(--color-ink-2)" }}
            >
              这页写的是本机 sqlite 里的
              <span className="num mx-1">person / employment / residence / education / tax_record</span>
              五张表，保存是一次全量替换。分数只用于自己的判断，不对外提交。
            </div>

            <button className="m-row-act mt-5" onClick={() => go("workplace")}>
              去公司地点线路维护 →
            </button>
          </aside>
        </div>
      </div>
    </>
  );
}
