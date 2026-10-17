"use client";

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { FundingResult } from "@/lib/funding-model";

const PANEL = "min-w-0 rounded-lg border p-4";
const PANEL_STYLE = {borderColor:"var(--card-border)",background:"var(--card)"};
const MUTED = "var(--muted)";
const usd = (n:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(n);

/** Distinct y-axis ranges are intentional: an unhedged short's directional PnL
 * can dwarf the smaller funding/hedged PnL and visually flatten it.
 * Charts are separate; NEVER compare their heights as equal dollar magnitudes. */
export default function FundingPerformanceCharts({result}:{result:FundingResult}){
  return <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label="분리된 누적 손익 차트">
    <section className={PANEL} style={PANEL_STYLE}>
      <h2 className="font-semibold">펀딩비 · 헤지 누적 순손익</h2>
      <p className="mb-4 mt-1 text-xs" style={{color:MUTED}}>펀딩비는 비용 전, 헤지 순손익은 진입·청산 수수료·슬리피지 반영. 단위 USD.</p>
      <div className="h-[270px] w-full min-w-0" role="img" aria-label="펀딩비와 헤지 순손익 그래프">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={result.curve} margin={{top:10,right:8,left:0,bottom:5}}>
            <CartesianGrid stroke="#ffffff15" vertical={false}/>
            <XAxis dataKey="time" tickFormatter={(v:string)=>v.slice(5,10)} minTickGap={24} tick={{fill:"#a3a8b4",fontSize:11}}/>
            <YAxis tickFormatter={(v:number)=>"$"+Number(v).toFixed(Math.abs(v)<10?1:0)} tick={{fill:"#a3a8b4",fontSize:11}} width={63}/>
            <Tooltip formatter={value=>usd(Number(value??0))} labelFormatter={v=>String(v).slice(0,16)+" UTC"}
              contentStyle={{background:"#121923",border:"1px solid #30363d",borderRadius:8}}/>
            <Legend wrapperStyle={{fontSize:11}}/>
            <Line dataKey="fundingUsd" name="누적 펀딩비 (비용 전)" stroke="#58a6ff" dot={false} strokeWidth={2} isAnimationActive={false}/>
            <Line dataKey="hedgedNetUsd" name="헤지 순손익 (비용 후)" stroke="#3fb986" dot={false} strokeWidth={2} isAnimationActive={false}/>
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
    <section className={PANEL} style={PANEL_STYLE}>
      <h2 className="font-semibold">1배 숏 단독 손익 · 가격 위험</h2>
      <p className="mb-4 mt-1 text-xs" style={{color:MUTED}}>숏 방향성 노출을 별도 Y축으로 표시. 왼쪽 차트와 축 범위가 다르므로 높이를 직접 비교하면 안 됩니다.</p>
      <div className="h-[270px] w-full min-w-0" role="img" aria-label="1배 숏 단독 순손익 그래프">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={result.curve} margin={{top:10,right:8,left:0,bottom:5}}>
            <CartesianGrid stroke="#ffffff15" vertical={false}/>
            <XAxis dataKey="time" tickFormatter={(v:string)=>v.slice(5,10)} minTickGap={24} tick={{fill:"#a3a8b4",fontSize:11}}/>
            <YAxis tickFormatter={(v:number)=>"$"+Math.round(v)} tick={{fill:"#a3a8b4",fontSize:11}} width={63}/>
            <Tooltip formatter={value=>usd(Number(value??0))} labelFormatter={v=>String(v).slice(0,16)+" UTC"}
              contentStyle={{background:"#121923",border:"1px solid #30363d",borderRadius:8}}/>
            <Legend wrapperStyle={{fontSize:11}}/>
            <Line dataKey="shortNetUsd" name="1배 숏 단독 순손익" stroke="#fa9f69" dot={false} strokeWidth={2} isAnimationActive={false}/>
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  </div>;
}
