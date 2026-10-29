import XCTest

// 在真实 iOS 壳（WKWebView + cardanowatch:// scheme + 原生 Koios 桥）里走完整流程：
// 导入公钥 → 创建钱包 → 原生网络桥同步 → 收款地址与桌面版派生结果一致。
// 前置条件：全新安装（localStorage 为空）。
final class CardanoWatchUITests: XCTestCase {
    private static let expectedAddress =
        "addr1q9g52vj7aa592p96w9056vcm836s25w3tk42l62a5h9e0wtsg97aye04macd2n8gqkcylus22yll4yvarht8uxn0wf0qhm6gec"
    private static let keys = [
        "acct_xvk1wdqjt36fx6cn5fx4kmd9crl9rqydazwa49w9q5azk47scz6ynzasunq343afq64lwf0sm6memz8rvy23s5sp7m8k3fscn43nhmrh9ec3drdw2",
    ]

    func testImportSyncAndReceiveAddress() {
        let app = XCUIApplication()
        app.launch()
        removeExistingWalletIfNeeded(app)

        let start = app.descendants(matching: .any)["添加观察钱包"].firstMatch
        XCTAssertTrue(start.waitForExistence(timeout: 20), "初始空状态未出现")
        start.tap()

        let single = app.descendants(matching: .any)["单签 xpub"].firstMatch
        XCTAssertTrue(single.waitForExistence(timeout: 10), "导入面板未出现")
        single.tap()

        let xpubField = app.textViews
            .matching(NSPredicate(format: "label CONTAINS %@", "acct_xvk")).firstMatch
        XCTAssertTrue(xpubField.waitForExistence(timeout: 10), "公钥输入框未出现")
        xpubField.tap()
        xpubField.typeText(Self.keys[0])

        // 收起键盘，露出被遮挡的提交按钮
        let done = app.buttons["完成"].firstMatch
        if done.exists && done.isHittable { done.tap() }

        let submit = app.descendants(matching: .any)["创建单签观察钱包"].firstMatch
        XCTAssertTrue(submit.waitForExistence(timeout: 10), "提交按钮未出现")
        submit.tap()

        let receiveTab = app.tabBars.buttons["收款"]
        guard receiveTab.waitForExistence(timeout: 30) else {
            XCTFail("钱包创建后未出现标签栏：\(app.alerts.firstMatch.label)")
            return
        }

        let homeTab = app.tabBars.buttons["总览"]
        XCTAssertTrue(homeTab.isSelected, "新建钱包后应默认打开总览页")
        receiveTab.tap()
        let verify = app.buttons["独立核对地址以启用复制"].firstMatch
        XCTAssertTrue(verify.waitForExistence(timeout: 120), "同步后应显示二维码并提示逐地址核对")
        XCTAssertTrue(app.staticTexts["二维码已显示 · 地址尚未独立核对"].exists,
                      "未独立核对时也应展示二维码")
        let addressText = app.staticTexts
            .matching(NSPredicate(format: "label BEGINSWITH %@", "addr1")).firstMatch
        XCTAssertTrue(addressText.waitForExistence(timeout: 15), "收款页未显示地址")
        XCTAssertEqual(addressText.label, Self.expectedAddress,
                       "iOS 壳内派生的收款地址与桌面 0.3.4 向量不一致")
        let copy = app.buttons["复制地址"].firstMatch
        XCTAssertTrue(copy.exists && !copy.isEnabled, "未独立核对时不能一键复制")
        verify.tap()
        let expected = app.textViews
            .matching(NSPredicate(format: "label CONTAINS %@", "另一设备算出的完整地址")).firstMatch
        XCTAssertTrue(expected.waitForExistence(timeout: 10), "核对输入框未出现")
        expected.tap()
        expected.typeText(Self.expectedAddress)
        let confirm = app.buttons["完整地址一致，启用复制"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        XCTAssertTrue(copy.waitForExistence(timeout: 10) && copy.isEnabled,
                      "完整地址核对成功后应允许一键复制")

        XCTAssertTrue(homeTab.waitForExistence(timeout: 10))
        homeTab.tap()
        let history = app.buttons["交易历史"].firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 10), "总览缺少交易历史入口")
        history.tap()
        let back = app.buttons["返回总览"].firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 10), "交易历史应作为独立页面打开")
        XCTAssertFalse(homeTab.isHittable, "历史页应隐藏原生标签栏")
        back.tap()
        XCTAssertTrue(history.waitForExistence(timeout: 10), "左上角返回后应回到总览")

        let addressesTab = app.tabBars.buttons["地址"]
        XCTAssertTrue(addressesTab.waitForExistence(timeout: 10))
        addressesTab.tap()
        let firstRow = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "#0")).firstMatch
        XCTAssertTrue(firstRow.waitForExistence(timeout: 10), "地址列表未出现")
        firstRow.tap()
        XCTAssertTrue(app.staticTexts[Self.expectedAddress].waitForExistence(timeout: 10),
                      "展开后必须显示完整、未缩写的地址")
        attach(app, name: "Expanded address row")

        let stakingTab = app.tabBars.buttons["质押"]
        XCTAssertTrue(stakingTab.waitForExistence(timeout: 10))
        stakingTab.tap()
        XCTAssertTrue(app.staticTexts["质押奖励"].waitForExistence(timeout: 10),
                      "质押页面未出现")
        XCTAssertTrue(app.staticTexts["质押地址"].exists, "质押地址未显示")
        XCTAssertTrue(app.staticTexts["未注册"].waitForExistence(timeout: 30),
                      "原生桥未能读取测试向量的质押状态")
        attach(app, name: "Staking page")

        let details = app.buttons["钱包设置"].firstMatch
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        details.tap()
        XCTAssertTrue(app.staticTexts["账户公钥"].waitForExistence(timeout: 10),
                      "账户公钥资料应位于右上角钱包详情")
        XCTAssertTrue(app.staticTexts["当前钱包后台动账通知"].exists)
        XCTAssertTrue(app.buttons["已关闭"].exists,
                      "原生通知 bridge 未注册时会错误显示‘仅 iOS App 支持’")
        attach(app, name: "Wallet details sheet")

        let rename = app.buttons["修改"].firstMatch
        XCTAssertTrue(rename.waitForExistence(timeout: 10), "钱包详情缺少修改名称入口")
        rename.tap()
        let nameField = app.textFields
            .matching(NSPredicate(format: "label CONTAINS %@", "新名称")).firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 10))
        nameField.typeText("测试观察钱包")
        let saveName = app.buttons["保存名称"].firstMatch
        XCTAssertTrue(saveName.waitForExistence(timeout: 10))
        saveName.tap()
        XCTAssertTrue(app.buttons
            .matching(NSPredicate(format: "label CONTAINS %@", "测试观察钱包")).firstMatch
            .waitForExistence(timeout: 10), "修改后的名称没有显示在当前钱包入口")
        details.tap()
        XCTAssertTrue(app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "测试观察钱包")).firstMatch
            .waitForExistence(timeout: 10),
                      "钱包名称未保存到详情页")

        let export = app.buttons["导出 descriptor"].firstMatch
        XCTAssertTrue(export.waitForExistence(timeout: 10))
        export.tap()
        XCTAssertTrue(app.otherElements["ActivityListView"].waitForExistence(timeout: 10),
                      "descriptor 导出未打开 iOS 分享面板")
        attach(app, name: "Descriptor share sheet")
    }

    // 全新安装假设失败时的兜底：清掉上次测试残留的钱包（localStorage 持久化在设备上）
    private func removeExistingWalletIfNeeded(_ app: XCUIApplication) {
        let settings = app.buttons["钱包设置"].firstMatch
        guard settings.waitForExistence(timeout: 8) else { return }
        settings.tap()
        let remove = app.buttons["移除手机中的钱包"].firstMatch
        for _ in 0..<4 where !remove.exists || !remove.isHittable {
            app.swipeUp(velocity: .slow)
        }
        guard remove.waitForExistence(timeout: 5) else { return }
        remove.tap()
        for _ in 0..<2 {
            let confirm = app.alerts.buttons["确认"].firstMatch
            guard confirm.waitForExistence(timeout: 5) else { break }
            confirm.tap()
        }
        _ = app.buttons["添加钱包"].firstMatch.waitForExistence(timeout: 5)
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
    }
}
